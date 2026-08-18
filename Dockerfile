# Multi-stage: the TypeScript toolchain builds the app and then stays behind.
#
# The Python image had to uninstall pip after installing, because a build tool
# left in a runtime image is both extra attack surface and a standing source of
# CVE noise — the scanner reports flaws in code the service never imports. Node
# has the same problem in a bigger way: typescript, tsx and the @types packages
# are ~200MB of dependencies that exist only to produce `dist`. A build stage is
# how that gets left behind rather than shipped and then apologised for.

# ---- build -------------------------------------------------------------------
FROM node:22-slim AS build

WORKDIR /app

# Copied before the source so a change to the app does not invalidate the
# dependency layer; `npm ci` is the slow step and it only needs these two.
COPY package.json package-lock.json ./
# `ci`, not `install`: it installs exactly the lockfile and fails if the two
# have drifted, which is what makes a build reproducible.
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY scripts ./scripts
COPY src ./src

# Compiles to dist/ AND copies the 13 email templates in. The copy step
# verifies its own result: tsc emits only what it compiles, so without it the
# image starts, serves every endpoint, and silently sends every customer email
# as plain text with the design missing.
RUN npm run build

# ---- runtime -----------------------------------------------------------------
FROM node:22-slim AS runtime

ENV NODE_ENV=production

WORKDIR /app

COPY package.json package-lock.json ./
# Production dependencies only, then npm itself is removed.
#
# npm is a build tool. Left in the runtime image it is a standing source of CVE
# noise: it bundles its own copies of tar, sigstore, picomatch, brace-expansion
# and ip-address, and a scan reports the image as vulnerable to flaws in code
# this service never imports and cannot reach. That was five of the six HIGH/
# CRITICAL findings on the first build of this image, and deleting npm is what
# actually resolves them rather than suppressing them.
#
# The CMD is `node dist/server.js` and the healthcheck is `node -e ...`; neither
# needs npm. (The Python image removes pip after installing for exactly the same
# reason — same lesson, different ecosystem.)
RUN npm ci --omit=dev     && npm cache clean --force     && rm -rf /usr/local/lib/node_modules/npm               /usr/local/bin/npm /usr/local/bin/npx

COPY --from=build /app/dist ./dist

# Run as an unprivileged user: a container process that does not need root
# should not have it, so a compromise in the app is not a compromise of the
# container. The node image ships a `node` user (uid 1000) for exactly this.
RUN chown -R node:node /app
USER node

EXPOSE 8001

# Reports unhealthy once /health stops answering, so an orchestrator can replace
# the instance instead of leaving it in rotation serving errors.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:8001/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# `node dist/server.js` directly, with no npm wrapper: npm forks a shell that
# forks node, and the shell does not forward SIGTERM. The server's graceful
# shutdown — finish in-flight requests, then close Mongo — would never run, and
# every deploy would drop the requests in flight.
CMD ["node", "dist/server.js"]
