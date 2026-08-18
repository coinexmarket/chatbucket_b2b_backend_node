# Deploying the Node service

This service is designed to be deployed **alongside** the Python one, not in
place of it. Both read and write the same MongoDB, so you can run them together,
compare their answers on real traffic, and only then move the domain. Nothing in
this document points `api.b2b.chatbucket.business` at Node; that is a separate,
deliberate change described in [Cutting over](#cutting-over).

---

## The pipeline

`.github/workflows/deploy.yml`. One workflow covers proving a change is correct,
proving it is not vulnerable, and shipping it.

```
pull request ──► test ──► image-smoke          (dependency-review, codeql alongside)
                  │
push to main ──► test ─┬─► publish ──► DOCR ──► App Platform ──► /health
                codeql ┘
```

| Job | When | What it does |
| --- | --- | --- |
| `test` | always | Node 20/22/24 against a **real MongoDB** service container: typecheck, then all seven suites, then the build |
| `codeql` | always | Static analysis of the TypeScript, `security-and-quality` queries |
| `dependency-review` | PRs | Refuses a new dependency with a known high-severity vulnerability |
| `image-smoke` | PRs | Builds the image, Trivy-scans it, then boots it |
| `publish` | main / manual | Builds, scans, **boots**, then pushes — commit tag first, `latest` last |

Four properties are deliberate:

**The image is scanned and booted before it is pushed.** Scanning after
publication means the vulnerable image is already the one production is being
told to deploy. `publish` builds with `load: true`, checks it locally, and only
then pushes.

**`latest` moves last.** The commit tag is immutable and is what a rollback
names; App Platform follows `latest`, so it moves only once the thing it will
deploy is safely stored under a fixed name.

**App Platform's own deploy-on-push is not the gate.** It ships whatever arrives
in the registry. The gate is `needs: [test, codeql]` — a red main never produces
an image at all.

**Every action is pinned to an exact patch.** A floating major tag is a moving
target: the same commit can build differently tomorrow because somebody else
released, and nothing in this repository would record it. Upgrades are a commit,
reviewed like any other.

### The tests need a database

Unlike the Python pipeline, `test` runs a `mongo:7` service container. The suites
deliberately test behaviour that lives *in* MongoDB — unique indexes, TTL expiry,
atomic `$inc` under `$gte`, `$sum` over `Decimal128` — and a mock that
reimplemented those would be testing the mock.

---

## One-time setup

### 1. The registry repository

The image pushes to `registry.digitalocean.com/chatbucket/b2b-backend-node`,
which is a **separate repository** from the Python service's `b2b-backend`. They
must not share one: `latest` is what App Platform follows, and two services
publishing to the same tag would deploy each other's code.

```bash
doctl registry login
# The repository is created on first push; nothing to do here beyond confirming
# the registry name matches REGISTRY in the workflow.
doctl registry get
```

### 2. The GitHub secret

The workflow needs exactly one:

| Secret | Used for |
| --- | --- |
| `DIGITALOCEAN_ACCESS_TOKEN` | `doctl registry login`, so the image can be pushed |

A token with **read/write on the container registry** is enough. It does not
need app-management scope — the deploy is triggered by the registry push, not by
an API call.

```
GitHub → Settings → Secrets and variables → Actions → New repository secret
```

### 3. The app

```bash
doctl apps create --spec .do/app.yaml
```

Then set the runtime secrets. The spec references them as `${NAME}` and marks
them `type: SECRET`, so App Platform holds them encrypted and they never appear
in this repository:

```
DigitalOcean → Apps → chatbucket-b2b-backend-node → Settings → App-Level Environment Variables
```

| Secret | Notes |
| --- | --- |
| `MONGODB_URI` | **The same cluster as the Python service.** |
| `JWT_SECRET` | **Byte-identical to the Python service's** — see below. |
| `BILLING_WEBHOOK_SECRET`, `STATUS_WEBHOOK_SECRET`, `OPS_SECRET` | Each fails closed (503) when unset |
| `SMTP_PASSWORD` | |
| `SMS_API_URL`, `SMS_USERNAME`, `SMS_API_KEY`, `SMS_SENDER_ID`, `SMS_TEMPLATE_ID` | |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | The webhook secret is a **different value** from the key secret |

### 4. Two settings that will bite if they are wrong

**`JWT_SECRET` must match the Python service exactly.** A token issued by one has
to be accepted by the other while traffic is split, and verification codes are
HMAC'd under it — a different value silently invalidates every outstanding OTP
and signs everybody out mid-session. Copy it; do not generate a new one.

**`NOTIFICATION_SCHEDULER_ENABLED` must be true in at most one service.** Both
would not double-send — the `(job, period)` lock is shared through Mongo — but
one service should own the lifecycle mail. While Python owns it, this stays
`false`, which is what the spec ships.

---

## Deploying a change

Merge to `main`. That is the whole procedure:

1. `test` and `codeql` must pass, or nothing is built.
2. `publish` builds, Trivy-scans, boots the image, then pushes
   `:<commit-sha>` followed by `:latest`.
3. App Platform sees `latest` move and deploys it.
4. The workflow waits for `https://api-node.b2b.chatbucket.business/health` to
   report `"database":"up"` before it reports success — App Platform reacts
   asynchronously, so reporting success at upload would be reporting that the
   file arrived, not that the service works.

To rebuild and ship without an empty commit: **Actions → Build, test and deploy →
Run workflow**.

---

## Verifying a deploy

The service starts even when Mongo is briefly unreachable and reports 503 with
`"database":"down"` until it recovers, so `/health` genuinely reflects readiness:

```bash
curl -s https://api-node.b2b.chatbucket.business/health
# {"status":true,"service":"ChatBucket B2B Backend (Node)","database":"up","indexes":"ready"}
```

`indexes: "pending"` that never becomes `ready` means the index build is stuck —
usually a duplicate `users.phone` blocking the unique index. Registration falls
back to an explicit lookup while that is true, so it is degraded rather than
broken, but it wants fixing.

The `service` field deliberately says `(Node)`. That is how you tell which
service answered while both are running.

---

## Cutting over

Do not move the domain because the suites pass. They compare each service
against itself. Compare the two against each other:

```bash
python scripts/parity-live.py
# 39 identical, 0 different, 39 compared
```

That harness authenticates once and diffs both services' answers across public,
authenticated, error and secret-gated routes. It found five contract differences
that every test suite had missed, because each service was internally consistent
and they disagreed only with each other. Run it against production URLs before
cutting over, not just locally.

Two differences are expected and named in the harness: Python prints `4.0` where
JavaScript prints `4`, and timestamps end `+00:00` rather than `Z`. Same values,
same instants.

When it is clean:

1. Point `api.b2b.chatbucket.business` at the Node app, or move the ingress rule.
2. Move `NOTIFICATION_SCHEDULER_ENABLED=true` from the Python app to this one —
   in that order, so neither owns it for a moment rather than both.
3. Leave the Python app running and reachable on its own hostname. It is the
   rollback.

---

## Rolling back

The commit tag is immutable, so a rollback is a re-tag rather than a rebuild:

```bash
doctl registry repository list-tags b2b-backend-node
docker pull registry.digitalocean.com/chatbucket/b2b-backend-node:<good-sha>
docker tag  registry.digitalocean.com/chatbucket/b2b-backend-node:<good-sha> \
            registry.digitalocean.com/chatbucket/b2b-backend-node:latest
docker push registry.digitalocean.com/chatbucket/b2b-backend-node:latest
```

If the problem is with the port itself rather than one change, point the domain
back at the Python service. That is the whole reason it stays deployed.

---

## What is deliberately unset

Each of these is off until somebody decides otherwise, and each default is the
safe direction:

| Setting | Default | Why |
| --- | --- | --- |
| `NOTIFICATION_SCHEDULER_ENABLED` | `false` | Booting must never start mailing customers |
| `TRUST_PROXY_HEADERS` | `false` in code, **`true` in the spec** | Behind App Platform there is a proxy; with nothing in front, a forged `X-Forwarded-For` would bypass every per-IP limit |
| `SMS_TEMPLATE_SUFFIX` | empty | A word the DLT registration does not have makes the operator drop the message while the gateway still answers 200 and reports "Delivered" |
| `ENGINE_FREE_QUOTAS` | empty | An invented capacity makes `remaining` read as authoritative while being fiction |
| `STATUS_PROBE_URLS` | empty | No prober runs; this deployment reports status by heartbeat |
| Per-model rates | empty | Same reason as quotas |
| Invoice tax | `not_computed` | A zero is a claim this service is not equipped to make |

---

## Mail

The scheduler stays off until `chatbucket.business` publishes **SPF and DMARC**.
Enabling it first mails the whole customer base from an unauthenticated domain,
straight into spam, and sender reputation is much easier to keep than to repair.

Check before enabling:

```bash
nslookup -type=TXT chatbucket.business        # expect v=spf1 ...
nslookup -type=TXT _dmarc.chatbucket.business # expect v=DMARC1 ...
```

---

## Payments

`RAZORPAY_WEBHOOK_SECRET` is a **different value** from `RAZORPAY_KEY_SECRET`.
The webhook signature is computed over the raw request bytes under the webhook
secret; signing against the wrong one rejects every delivery, and a rejected
webhook means a customer who paid never receives their credits.

Point the gateway's webhook at:

```
https://api-node.b2b.chatbucket.business/billing/webhook/razorpay
```

**No proxy in that path may re-encode the body.** The signature covers the exact
bytes sent; a re-serialised JSON body hashes differently and every delivery is
refused. The app already excludes that one route from its JSON parser for the
same reason.
