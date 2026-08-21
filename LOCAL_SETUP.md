# Running this locally

Two ways, and the first is the one to reach for.

| | Database | Use it for |
| --- | --- | --- |
| **Local MongoDB** | your own, empty | everything, unless you specifically need real data |
| **Production MongoDB** | live customer data | reproducing a bug that only appears with real records |

The second reads and writes production. Nothing about it is a sandbox: a
document you edit while poking around is a customer's document.

---

## 1. Local MongoDB

```bash
npm install
cp .env.example .env
npm run dev               # http://127.0.0.1:8001
```

`.env.example` points at `mongodb://127.0.0.1:27017` and leaves every credential
blank, which is what you want — mail prints to the console, SMS prints the code,
and no payment gateway is configured, so `/billing/top-up` records a local
pending payment instead of calling out.

Verify:

```bash
npm run typecheck
npm run test:all
```

The suites use a throwaway database (`chatbucket_b2b_nodetest`) against a real
MongoDB rather than a mock, because most of what is being tested lives *in*
MongoDB — unique indexes, TTL expiry, atomic `$inc` under `$gte`.

---

## 2. Production MongoDB

### Get access

Ask for two things. Neither is in the repository, and neither should be pasted
into a chat, an issue, or a commit.

1. **A database user and password.** Use `dev`, not `cb-b2b-app` — that is the
   one the live service authenticates as, and sharing it means a rotation
   locks out production. Passwords are visible under
   Databases → `cb-b2b-mongodb-pord` → Users & Databases.
2. **Your IP on the trusted-sources list.** The cluster's firewall holds one
   rule, of type `app`, naming the live service. Everything else times out
   rather than being refused, so a missing rule looks like a hanging connection
   rather than a permission error.

Take the IP rule off when you are done. A home address is reassigned
eventually, and the rule outlives the afternoon that needed it.

### The cluster name is a trap

```
cb-b2b-mongodb-pord      <- this service
cb-db-mongodb-pord       <- the consumer app. Not this. Not related.
```

One segment apart. The wrong one holds 66 collections and around eleven
thousand users of a different product, and connecting to it succeeds — you get
an empty `chatbucket_b2b` and conclude the data is gone. If your user count is
zero, check the hostname before anything else.

### Configure

```
MONGODB_URI=mongodb+srv://dev:<password>@cb-b2b-mongodb-pord-f99d810f.mongo.ondigitalocean.com/admin?replicaSet=cb-b2b-mongodb-pord&tls=true&authSource=admin
MONGODB_DB=chatbucket_b2b
```

`MONGODB_DB` is what selects the data. The `/admin` in the URI is the
authentication database and is not where the collections live.

### Three settings that must stay as they are

These are the difference between reading production and *acting* on it. Each
has a plausible-looking reason to flip it and a consequence that reaches a
customer.

```
EMAIL_BACKEND=console
```

Recipient lists are real people. An SMTP backend here means your local
experiment mails them, and there is no recall.

```
SMS_BACKEND=disabled
```

Same, plus a per-message cost. The code is printed to the log, which is all a
local test needs.

```
NOTIFICATION_SCHEDULER_ENABLED=false
```

The subtle one. The scheduler's `(job, period)` lock is shared through Mongo, so
a second scheduler is not merely redundant — whichever process claims the period
*owns* that day's send. If that is your laptop, the mail goes out through a
console backend and the real run is recorded as already done. Customers then
never receive it, and nothing anywhere reports an error.

Payment keys stay blank. If you need the checkout path, use test keys; live keys
take real money from real accounts.

### JWT_SECRET

Any value. Sign in against your local service and it mints a token and verifies
its own.

It is not the production secret — App Platform encrypts that on save and will
not show it again. What differing costs you is anything signed elsewhere: a
session started on the live dashboard is rejected locally, and an email or phone
code already in the database will not validate, because those are HMAC'd under
the secret that wrote them.

The direction that matters is the reverse. A code issued *locally* is stored in
the production database hashed under your value, so the live service cannot
verify it either. Only reachable on an account you register yourself, but it is
why this setup is for your own test accounts and not a customer's.

Reading the real one means going into the running container:

```bash
doctl apps console 779b0f28-1691-4bf1-b599-17995f615658 api
echo $JWT_SECRET
```

### Point the dashboard at it

In the `cb_b2b` repo:

```
NEXT_PUBLIC_API_URL=http://localhost:8001
```

`NEXT_PUBLIC_*` is compiled in at build time, so restart the dev server. Left
unset it falls back to `https://api.b2b.chatbucket.business`, which is
production — a stale dev server is the usual reason a local change appears to
have no effect.

---

## Where things run

| | |
| --- | --- |
| API | `https://api.b2b.chatbucket.business` |
| App | `chatbucket-b2b-backend-node` (`779b0f28-1691-4bf1-b599-17995f615658`) |
| Cluster | `cb-b2b-mongodb-pord`, database `chatbucket_b2b` |
| Deploys | push to `main`; CI builds, smoke-tests the image, then deploys |

The Python service this was ported from was retired on 20 August 2026. Its
repository is kept as the reference implementation the port was verified
against — where behaviour here looks odd, that is usually why.

## Scripts

Both refuse to write without `--commit`, and report first.

| | |
| --- | --- |
| `scripts/backfill-notifications.mjs` | Marks accounts as already-notified, so enabling the scheduler does not mail the back catalogue |
| `scripts/phone-duplicates.mjs` | Resolves accounts sharing a mobile number, by releasing the number rather than deleting anything |
