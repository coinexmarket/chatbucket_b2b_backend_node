"""Dump the field names the PYTHON service writes, as parity fixtures.

Run from the Python repo so `app` is importable:

    cd ../chatbucket_b2b_backend
    python ../chatbucket_b2b_node/test/fixtures/dump_schema.py

It writes `python-schema.json` next to itself. `test/schema-parity.ts` asserts
the Node service writes every field listed there.

Uses an in-memory Mongo, so it touches no real data and needs no credentials.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

os.environ.setdefault("JWT_SECRET", "schema-dump")
os.environ.setdefault("MONGODB_URI", "mongodb://127.0.0.1:27017")

# The repo root, so `import app` works however this is invoked.
sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "chatbucket_b2b_backend"))

from mongomock_motor import AsyncMongoMockClient  # noqa: E402

from app import credits, database, verification  # noqa: E402


async def main() -> None:
    client = AsyncMongoMockClient()
    database._mongo.client = client                    # type: ignore[attr-defined]
    database._mongo.b2b_db = client["chatbucket_b2b"]  # type: ignore[attr-defined]

    user_id = "schema-probe-user"

    # credit_accounts + credit_ledger
    await credits.grant(user_id, credits.to_units("100"),
                        credits.KIND_SIGNUP_BONUS, "Welcome credits")
    account = await database.credit_accounts_collection().find_one({"user_id": user_id})
    ledger = await database.credit_ledger_collection().find_one({"user_id": user_id})

    # phone_verifications
    await verification.issue_pending_phone_code("+919000000001")
    pending = await database.phone_verifications_collection().find_one(
        {"phone": "+919000000001"}
    )

    def keys(doc: dict | None) -> list[str]:
        return sorted(k for k in (doc or {}) if k != "_id")

    out = {
        "credit_accounts": keys(account),
        "credit_ledger": keys(ledger),
        "phone_verifications": keys(pending),
        # Written inline by routers/auth.register rather than by a helper, so
        # listed explicitly instead of probed.
        "users": sorted([
            "name", "email", "company", "phone", "how_did_you_hear",
            "terms_accepted_at", "terms_version", "plan", "email_verified",
            "password_hash", "token_version", "created_at", "updated_at",
        ]),
    }

    target = Path(__file__).with_name("python-schema.json")
    target.write_text(json.dumps(out, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {target}")
    for collection, fields in out.items():
        print(f"  {collection}: {', '.join(fields)}")


asyncio.run(main())
