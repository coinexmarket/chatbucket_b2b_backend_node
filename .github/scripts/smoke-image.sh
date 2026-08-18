#!/usr/bin/env bash
# Boot a built image and prove it is actually serviceable.
#
# Shared by the pull-request check and the publish job so the two cannot drift —
# an image proven on a PR and a different check on main is how a gap opens.
#
# Deliberately more than "the port answers". The failure this catches is an
# image that starts perfectly and is quietly broken: the email templates are
# plain .html files that `tsc` does not emit, and without them the service
# serves every endpoint and sends every customer email as unstyled plain text,
# because `email.ts` falls back rather than erroring. Nothing in a health check
# would ever notice.
set -euo pipefail

IMAGE="${1:?usage: smoke-image.sh <image>}"
NAME="cb-node-smoke-$$"
# An ephemeral host port, not the service's own: a runner (or a developer's
# laptop) may already have something on 8001, and a port clash failing the
# image check would be a false negative about the image.
PORT=$(( 20000 + RANDOM % 20000 ))

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# No MONGODB_URI that resolves, so the service must come up and answer rather
# than crash-looping — that is the behaviour a load balancer depends on while a
# database is briefly unreachable.
docker run -d --name "$NAME" -p "$PORT:8001" \
  -e ENVIRONMENT=development \
  -e JWT_SECRET=smoke-check \
  -e EMAIL_BACKEND=console \
  -e SMS_BACKEND=console \
  "$IMAGE" >/dev/null

# With no reachable database, /health must answer 503 with "database":"down" —
# not hang, not crash-loop. That is the contract a load balancer routes on, and
# a container that exits instead has no health endpoint left to report with.
code=""
for _ in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT/health" || true)
  [ -n "$code" ] && [ "$code" != "000" ] && break
  sleep 2
done

if [ "$code" != "503" ]; then
  echo "with no database, /health should answer 503; got ${code:-no response}" >&2
  docker logs "$NAME" >&2
  exit 1
fi

body=$(curl -s "http://localhost:$PORT/health")
case "$body" in
  *'"database":"down"'*) ;;
  *) echo "health did not report the database as down: $body" >&2
     docker logs "$NAME" >&2
     exit 1;;
esac

# A route that does not touch the database still serves, so the process is
# genuinely up rather than merely answering its own probe.
pricing=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT/pricing" || true)
if [ "$pricing" != "200" ]; then
  echo "/pricing should serve without a database; got ${pricing:-no response}" >&2
  docker logs "$NAME" >&2
  exit 1
fi

# The 13 designed templates must be in the image, not just on a developer's disk.
count=$(docker exec "$NAME" sh -c 'ls dist/templates/emails/*.html 2>/dev/null | wc -l')
if [ "$count" -ne 13 ]; then
  echo "expected 13 email templates in the image, found $count" >&2
  exit 1
fi

# And they must actually render from the built output — being present is not the
# same as being resolvable from dist/, which is a path bug waiting to happen.
docker exec -e JWT_SECRET=smoke-check -e EMAIL_BACKEND=memory "$NAME" \
  node -e "
    const t = await import('./dist/emailtemplates.js');
    const html = t.render('welcome', { name: 'CI', bonus_credits: '100', credit_validity_days: 30 });
    if (html.length < 1000) { console.error('welcome template rendered ' + html.length + ' bytes'); process.exit(1); }
    if (/\{\{[^}]+\}\}/.test(html)) { console.error('unrendered placeholder in output'); process.exit(1); }
    console.log('templates render from dist (' + html.length + ' bytes)');
  " --input-type=module

# A container that ignores SIGTERM has every deploy drop the requests in flight.
docker stop -t 15 "$NAME" >/dev/null
exit_code=$(docker inspect "$NAME" --format '{{.State.ExitCode}}')
if [ "$exit_code" != "0" ]; then
  echo "container did not shut down gracefully on SIGTERM (exit $exit_code)" >&2
  docker logs "$NAME" >&2
  exit 1
fi

echo "image smoke passed: serves /health, carries and renders 13 templates, exits cleanly"
