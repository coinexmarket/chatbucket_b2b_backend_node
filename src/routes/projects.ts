/**
 * Projects — a customer's own grouping for keys and the usage they generate.
 *
 * Ported from `app/routers/projects.py`.
 *
 * A project is attached to an **API key**, and usage inherits the project of the
 * key that reported it — so the metering services never have to know about
 * projects, and attribution cannot drift from whichever key actually did the
 * work.
 *
 * Deleting a project detaches its keys but **leaves historical usage alone**.
 * Rewriting past usage would change what a period cost under that project, which
 * is the one thing the attribution exists to record; the breakdown labels the
 * orphans instead.
 */
import { Router, type Request } from 'express';
import { MongoServerError, ObjectId } from 'mongodb';
import { z } from 'zod';

import { apiKeysCollection, projectsCollection } from '../database.js';
import { HttpError, asyncHandler } from '../errors.js';
import { requireUser, type AuthedRequest } from '../middleware/auth.js';
import { toIso } from '../serialization.js';

export const projectsRouter = Router();
projectsRouter.use(requireUser);

const NOT_FOUND = () => new HttpError(404, 'Project not found.');
const DUPLICATE = () => new HttpError(409, 'A project with this name already exists.');

const ProjectRequest = z
  .object({
    name: z.string().min(1).max(120),
    description: z.string().max(500).nullish(),
  })
  .strict();

const ProjectUpdateRequest = z
  .object({
    name: z.string().min(1).max(120).optional(),
    description: z.string().max(500).nullish(),
  })
  .strict();

/**
 * Case-folded key backing the unique index, so "Production" and "production"
 * cannot both exist and confuse the picker.
 */
function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** A malformed id is indistinguishable from someone else's project, and both
 *  should look the same to the caller. */
function oid(projectId: string): ObjectId {
  if (!ObjectId.isValid(projectId)) throw NOT_FOUND();
  return new ObjectId(projectId);
}

function view(doc: Record<string, unknown>, keyCount?: number): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: String(doc['_id']),
    name: doc['name'] ?? null,
    description: doc['description'] ?? null,
    created_at: toIso(doc['created_at']),
  };
  if (keyCount !== undefined) out['api_key_count'] = keyCount;
  return out;
}

/**
 * Validate that a project id belongs to this customer.
 *
 * Shared with the API-key routes: without this check a customer could attach
 * their key to someone else's project by guessing an id.
 */
export async function resolveProject(
  user: Record<string, unknown>,
  projectId: string | null | undefined,
): Promise<string | null> {
  if (!projectId) return null;
  const doc = await projectsCollection().findOne({
    _id: oid(projectId),
    user_id: user['_id'],
  });
  if (!doc) throw NOT_FOUND();
  return String(doc['_id']);
}

projectsRouter.post(
  '',
  asyncHandler(async (req: Request, res) => {
    const user = (req as AuthedRequest).user;
    const payload = ProjectRequest.parse(req.body);
    const now = new Date();

    const document: Record<string, unknown> = {
      user_id: user['_id'],
      name: payload.name.trim(),
      name_key: normalizeName(payload.name),
      description: payload.description?.trim() || null,
      created_at: now,
      updated_at: now,
    };
    try {
      const result = await projectsCollection().insertOne(document);
      document['_id'] = result.insertedId;
    } catch (err) {
      if (err instanceof MongoServerError && err.code === 11000) throw DUPLICATE();
      throw err;
    }
    res.status(201).json({ status: true, data: view(document, 0) });
  }),
);

projectsRouter.get(
  '',
  asyncHandler(async (req: Request, res) => {
    const user = (req as AuthedRequest).user;
    const limit = Math.min(500, Math.max(1, Number(req.query['limit'] ?? 100)));
    const offset = Math.max(0, Number(req.query['offset'] ?? 0));

    const query = { user_id: user['_id'] };
    const total = await projectsCollection().countDocuments(query);
    const docs = await projectsCollection()
      .find(query)
      .sort({ created_at: -1 })
      .skip(offset)
      .limit(limit)
      .toArray();

    // One grouped count rather than a query per project, so a customer with
    // fifty projects still costs two round trips.
    const counts = await apiKeysCollection()
      .aggregate([
        { $match: { user_id: user['_id'], project_id: { $ne: null } } },
        { $group: { _id: '$project_id', n: { $sum: 1 } } },
      ])
      .toArray();
    const byProject = new Map(counts.map((row) => [String(row['_id']), Number(row['n'])]));

    res.json({
      status: true,
      count: docs.length,
      total,
      data: docs.map((d) => view(d, byProject.get(String(d['_id'])) ?? 0)),
    });
  }),
);

projectsRouter.get(
  '/:projectId',
  asyncHandler(async (req: Request, res) => {
    const user = (req as AuthedRequest).user;
    const doc = await projectsCollection().findOne({
      _id: oid(String(req.params['projectId'])),
      user_id: user['_id'],
    });
    if (!doc) throw NOT_FOUND();

    const keys = await apiKeysCollection().countDocuments({
      user_id: user['_id'],
      project_id: String(doc['_id']),
    });
    res.json({ status: true, data: view(doc, keys) });
  }),
);

projectsRouter.patch(
  '/:projectId',
  asyncHandler(async (req: Request, res) => {
    const user = (req as AuthedRequest).user;
    const payload = ProjectUpdateRequest.parse(req.body);

    const updates: Record<string, unknown> = { updated_at: new Date() };
    if (payload.name !== undefined) {
      updates['name'] = payload.name.trim();
      updates['name_key'] = normalizeName(payload.name);
    }
    if (payload.description !== undefined) {
      updates['description'] = payload.description?.trim() || null;
    }
    if (Object.keys(updates).length === 1) {
      throw new HttpError(400, 'No fields to update.');
    }

    let doc;
    try {
      doc = await projectsCollection().findOneAndUpdate(
        { _id: oid(String(req.params['projectId'])), user_id: user['_id'] },
        { $set: updates },
        { returnDocument: 'after' },
      );
    } catch (err) {
      if (err instanceof MongoServerError && err.code === 11000) throw DUPLICATE();
      throw err;
    }
    if (!doc) throw NOT_FOUND();
    res.json({ status: true, data: view(doc) });
  }),
);

projectsRouter.delete(
  '/:projectId',
  asyncHandler(async (req: Request, res) => {
    const user = (req as AuthedRequest).user;
    const id = oid(String(req.params['projectId']));

    const doc = await projectsCollection().findOne({ _id: id, user_id: user['_id'] });
    if (!doc) throw NOT_FOUND();

    // The keys keep working — a project is a label, not a credential, so
    // removing it must not silently break a customer's integration. Historical
    // usage keeps the project id it was recorded under.
    const detached = await apiKeysCollection().updateMany(
      { user_id: user['_id'], project_id: String(id) },
      { $set: { project_id: null } },
    );
    await projectsCollection().deleteOne({ _id: id, user_id: user['_id'] });

    res.json({
      status: true,
      message: 'Project deleted. Its API keys still work, now unassigned.',
      keys_detached: detached.modifiedCount,
    });
  }),
);
