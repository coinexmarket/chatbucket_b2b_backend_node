/**
 * Refuse to run the suites against anything but a local MongoDB.
 *
 * Every suite overrides `MONGODB_DB` to a throwaway name and drops it at both
 * ends, but none of them override `MONGODB_URI` — that comes from `.env`. So
 * the database name is safe while the *cluster* is whatever the developer last
 * configured, and pointing `.env` at production to reproduce a bug is a
 * documented thing to do (see LOCAL_SETUP.md). The two combine badly: `npm
 * test` then creates a database on the production cluster, writes a few hundred
 * documents through it, and drops it again.
 *
 * That does not touch `chatbucket_b2b`, so it is not a data-loss bug. It is
 * still a test suite doing CREATE and DROP against production, on a cluster
 * whose firewall exists precisely to keep everything but the live service out,
 * and it is one typo in a database name away from being much worse.
 *
 * Import this first, before anything reads the environment.
 *
 * The escape hatch is deliberate but explicit: ALLOW_REMOTE_TEST_DB=1. Nobody
 * sets that by accident, which is the whole point.
 */
// `.env` is read by dotenv inside src/config.ts, not by the shell, so at this
// point process.env is still whatever the shell exported — which for the case
// this guard exists to catch is nothing at all. Load the file here too, or the
// check passes on an empty value and the suite goes on to connect to whatever
// `.env` names. dotenv never overwrites an existing variable, so an explicit
// `MONGODB_URI=... npm test` still wins.
import dotenv from 'dotenv';

dotenv.config();

const uri = process.env['MONGODB_URI'] ?? '';

// Empty means the suites fall back to their own local default. Fine.
if (uri && process.env['ALLOW_REMOTE_TEST_DB'] !== '1') {
  const host = uri.replace(/^mongodb(\+srv)?:\/\/([^@]*@)?/, '').split(/[/?,]/)[0] ?? '';
  const isLocal =
    host.startsWith('127.0.0.1') ||
    host.startsWith('localhost') ||
    host.startsWith('0.0.0.0') ||
    host.startsWith('[::1]') ||
    host.startsWith('host.docker.internal') ||
    host.startsWith('mongo:'); // the service name in docker-compose / CI

  if (!isLocal) {
    console.error(`
  Refusing to run tests against a non-local MongoDB.

    MONGODB_URI points at:  ${host}

  The suites drop and recreate their database. Against a remote cluster that
  is a CREATE and DROP on infrastructure somebody else is relying on.

  Point MONGODB_URI at a local MongoDB, or unset it to use the default:

    MONGODB_URI=mongodb://127.0.0.1:27017 npm test

  If you genuinely mean to use a remote one, say so:

    ALLOW_REMOTE_TEST_DB=1 npm test
`);
    process.exit(1);
  }
}

export {};
