"""Diff the live responses of the two services, endpoint by endpoint.

Both run against the same MongoDB with the same JWT_SECRET, so the same token
works on both and the same request should produce the same answer. That is the
check that matters before a cutover: the suites prove each service against
itself, this proves them against each other.

Differences that are expected and harmless are normalised away, and each is
named so the list cannot quietly grow:
  * JSON prints 4.0 in Python and 4 in JavaScript — the same number;
  * timestamps end +00:00 or Z, and a generated-at time differs per call;
  * the service name in /health is deliberately different so the two can be
    told apart while both are running.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import sys
import urllib.error
import urllib.request

sys.path.insert(0, 'D:/production_deployement/chatbucket_b2b_backend')

NODE = 'http://127.0.0.1:8001'
PY = 'http://127.0.0.1:8000'

# Keys whose value is a moment or a per-instance identity: equal shape, not
# equal value, and comparing them would only ever report noise.
VOLATILE = {
    'checked_at', 'generated_on', 'exported_at', 'service', 'last_reported_at',
    'reported_at', 'from', 'to', 'created_at', 'updated_at', 'issued_at',
    'paid_at', 'expires_in', 'access_token', 'refresh_token',
    'refresh_expires_at', 'period', 'previous_period',
}


def normalise(value):
    """Make the two services' JSON comparable without hiding real differences."""
    if isinstance(value, dict):
        return {k: ('<volatile>' if k in VOLATILE else normalise(v))
                for k, v in value.items()}
    if isinstance(value, list):
        return [normalise(v) for v in value]
    if isinstance(value, float) and value.is_integer():
        # Python prints 4.0 where JavaScript prints 4; same number.
        return int(value)
    if isinstance(value, str):
        # 2026-08-18T03:23:25.121Z and ...+00:00 are the same instant.
        if re.fullmatch(r'\d{4}-\d{2}-\d{2}T[\d:.]+(Z|\+00:00)', value):
            return '<timestamp>'
    return value


def call(base, method, path, token=None, body=None, headers=None):
    url = f'{base}{path}'
    data = json.dumps(body).encode() if body is not None else None
    hdrs = {'Content-Type': 'application/json'}
    if token:
        hdrs['Authorization'] = f'Bearer {token}'
    hdrs.update(headers or {})
    req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            raw = r.read().decode('utf-8', 'replace')
            return r.status, (json.loads(raw) if raw.strip().startswith(('{', '[')) else raw)
    except urllib.error.HTTPError as e:
        raw = e.read().decode('utf-8', 'replace')
        return e.code, (json.loads(raw) if raw.strip().startswith(('{', '[')) else raw)
    except Exception as exc:
        return 'ERR', str(exc)[:120]


async def main():
    from app import database
    from app.security import create_access_token_for_user

    await database.connect()

    # The account to authenticate as, given rather than hardcoded: this file is
    # committed, and a real customer's address does not belong in a repository.
    #
    #     PARITY_ACCOUNT=someone@example.com python scripts/parity-live.py
    #
    # With none supplied it uses the oldest account, which on any real database
    # is the operator's own rather than a customer's.
    wanted = os.environ.get('PARITY_ACCOUNT')
    query = {'email': wanted} if wanted else {}
    user = await database.users_collection().find_one(query, sort=[('created_at', 1)])
    if user is None:
        print(f'  no account found{f" for {wanted}" if wanted else ""}; nothing to compare as')
        return
    print(f'  authenticating as {user.get("email")}')
    print()
    token = create_access_token_for_user(user)

    # (method, path, needs auth, extra headers)
    CASES = [
        ('GET',  '/health',                                   False, None),
        ('GET',  '/pricing',                                  False, None),
        ('GET',  '/limits/plans',                             False, None),
        ('GET',  '/status',                                   False, None),
        ('GET',  '/status/tts',                               False, None),
        ('GET',  '/status/nope',                              False, None),
        ('GET',  '/v1/blogs',                                 False, None),
        ('GET',  '/v1/categories',                            False, None),
        ('GET',  '/v1/recent-blogs',                          False, None),
        ('GET',  '/v1/featured-blogs',                        False, None),
        ('GET',  '/v1/c-blogs?text=api',                      False, None),
        ('GET',  '/v1/blogs/definitely-missing',              False, None),
        ('GET',  '/v1/related-blogs/general',                 False, None),
        ('GET',  '/engines/usage',                            False, None),
        ('GET',  '/api/verify',                               False, None),
        ('GET',  '/api/verify?id=CB-HACK-2026-ZZZZZZ',        False, None),
        ('GET',  '/profile',                                  True,  None),
        ('GET',  '/limits',                                   True,  None),
        ('GET',  '/billing',                                  True,  None),
        ('GET',  '/billing/history',                          True,  None),
        ('GET',  '/billing/payments',                         True,  None),
        ('GET',  '/billing/details',                          True,  None),
        ('GET',  '/billing/invoices',                         True,  None),
        ('GET',  '/billing/invoices/INV-9999',                True,  None),
        ('GET',  '/api-keys',                                 True,  None),
        ('GET',  '/projects',                                 True,  None),
        ('GET',  '/account/export',                           True,  None),
        ('GET',  '/usage',                                    True,  None),
        ('GET',  '/usage/summary',                            True,  None),
        ('GET',  '/usage/overview?days=30',                   True,  None),
        ('GET',  '/usage/timeseries?granularity=daily&from=2026-04-01&to=2026-04-10', True, None),
        ('GET',  '/usage/timeseries?granularity=hourly&from=2026-04-01T00:00:00Z&to=2026-04-01T06:00:00Z', True, None),
        ('GET',  '/usage/timeseries?granularity=minute&from=2025-01-01&to=2026-01-01', True, None),
        ('GET',  '/usage/timeseries?granularity=nonsense',    True,  None),
        ('GET',  '/profile',                                  False, None),   # 401
        ('GET',  '/nope',                                     False, None),   # 404
        ('POST', '/usage/estimate',                           False, None),
        ('POST', '/notifications/onboarding-nudges',          False, None),   # 503, no OPS_SECRET
        ('POST', '/status/heartbeat',                         False, None),   # 503, no secret
    ]

    BODIES = {
        '/usage/estimate': {'service': 'tts_offline', 'quantity': 1000},
        '/notifications/onboarding-nudges': {'confirm': True},
        '/status/heartbeat': {'service': 'tts', 'status': 'operational'},
    }

    same = diff = 0
    problems = []

    for method, path, needs_auth, headers in CASES:
        body = BODIES.get(path.split('?')[0]) if method == 'POST' else None
        tok = token if needs_auth else None
        n_status, n_body = call(NODE, method, path, tok, body, headers)
        p_status, p_body = call(PY, method, path, tok, body, headers)

        label = f'{method} {path}'
        if n_status != p_status:
            diff += 1
            problems.append((label, f'status {n_status} vs {p_status}',
                             json.dumps(n_body)[:150], json.dumps(p_body)[:150]))
            continue
        if normalise(n_body) != normalise(p_body):
            diff += 1
            problems.append((label, f'body differs (both {n_status})',
                             json.dumps(normalise(n_body))[:200],
                             json.dumps(normalise(p_body))[:200]))
            continue
        same += 1
        print(f'  MATCH  {n_status}  {label}')

    print()
    if problems:
        print(f'  {len(problems)} DIFFERENCE(S):\n')
        for label, why, n, p in problems:
            print(f'  ---- {label}: {why}')
            print(f'       node  : {n}')
            print(f'       python: {p}')
            print()
    print(f'  {same} identical, {diff} different, {len(CASES)} compared')


asyncio.run(main())
