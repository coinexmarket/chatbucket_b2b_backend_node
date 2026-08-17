/**
 * Blog + category read endpoints.
 *
 * Ported from `app/routers/blogs.py`. These reproduce the contract the Next.js
 * frontend already calls, so the response envelope and the `dataKey` mirroring
 * below are not a design choice — they are what `useFetch` reads.
 *
 *   GET /v1/blogs                         all blogs (used by the sitemap)
 *   GET /v1/blogs/{slug}                  one full blog
 *   GET /v2/blogs/{slug}?category&sub_..  one full blog, category-scoped
 *   GET /v1/recent-blogs                  latest full blogs
 *   GET /v1/related-blogs/{category}      overviews in a category
 *   GET /v1/featured-blogs                featured overviews
 *   GET /v1/categories                    all categories
 *   GET /v1/c-blogs?categories&text       overviews filtered by category/search
 */
import { Router, type Request, type Response } from 'express';

import { blogsCollection, categoriesCollection } from '../database.js';
import { asyncHandler } from '../errors.js';
import { jsonSafe } from '../serialization.js';

export const blogsRouter = Router();

const RECENT_LIMIT = 6;
const FEATURED_LIMIT = 10;
const RELATED_LIMIT = 6;

/**
 * Fields the frontend's IBlogOverview intentionally omits from the full IBlog.
 * Dropping them keeps a list response from carrying every article's body.
 */
const OVERVIEW_OMIT = new Set([
  'body',
  'meta_title',
  'meta_keywords',
  'author',
  'section_ids',
  'og_image',
  'og_title',
  'og_description',
  'tags',
]);

function toOverview(doc: Record<string, unknown>): Record<string, unknown> {
  const full = jsonSafe(doc) as Record<string, unknown>;
  return Object.fromEntries(Object.entries(full).filter(([k]) => !OVERVIEW_OMIT.has(k)));
}

/**
 * The response envelope the blog frontend reads.
 *
 * `useFetch` supports a `dataKey` fallback: when `data` is absent it reads
 * `body[dataKey]`. Both paths are populated so either works — this mirrors the
 * Python service exactly, and changing it would break the live site.
 */
function success(
  res: Response,
  data: unknown,
  { message = 'Success', statusCode = 200, dataKey = '' } = {},
): void {
  const body: Record<string, unknown> = {
    status: true,
    status_code: statusCode,
    message,
    data,
    response_code: statusCode,
  };
  if (dataKey) body[dataKey] = data;
  res.status(statusCode).json(body);
}

function failure(res: Response, message: string, statusCode = 500): void {
  res.status(statusCode).json({
    status: false,
    status_code: statusCode,
    message,
    data: null,
    response_code: statusCode,
  });
}

/** All blogs (overview shape). The sitemap reads `body.blogs`. */
blogsRouter.get(
  '/v1/blogs',
  asyncHandler(async (_req: Request, res) => {
    const docs = await blogsCollection().find({}).sort({ createdAt: -1 }).toArray();
    success(res, docs.map(toOverview), { dataKey: 'blogs' });
  }),
);

/** Most recent blogs (full shape — LatestBlogsSection renders IBlog[]). */
blogsRouter.get(
  '/v1/recent-blogs',
  asyncHandler(async (_req: Request, res) => {
    const docs = await blogsCollection()
      .find({})
      .sort({ createdAt: -1 })
      .limit(RECENT_LIMIT)
      .toArray();
    success(res, docs.map(jsonSafe));
  }),
);

/** Blogs flagged `featured: true` (overview shape). */
blogsRouter.get(
  '/v1/featured-blogs',
  asyncHandler(async (_req: Request, res) => {
    const docs = await blogsCollection()
      .find({ featured: true })
      .sort({ createdAt: -1 })
      .limit(FEATURED_LIMIT)
      .toArray();
    success(res, docs.map(toOverview));
  }),
);

/** All categories. The frontend reads `body.categories`. */
blogsRouter.get(
  '/v1/categories',
  asyncHandler(async (_req: Request, res) => {
    const docs = await categoriesCollection().find({}).sort({ name: 1 }).toArray();
    success(res, docs.map(jsonSafe), { dataKey: 'categories' });
  }),
);

/**
 * Blogs filtered by selected categories and/or a free-text search.
 *
 * `categories` is a comma-separated list; `text` matches title, meta_desc and
 * tags. The frontend reads `body.blogs`.
 */
blogsRouter.get(
  '/v1/c-blogs',
  asyncHandler(async (req: Request, res) => {
    const query: Record<string, unknown> = {};

    const categories = String(req.query['categories'] ?? '');
    const wanted = categories.split(',').map((c) => c.trim()).filter(Boolean);
    if (wanted.length > 0) query['category'] = { $in: wanted };

    const text = String(req.query['text'] ?? '').trim();
    if (text) {
      // Escaped before it reaches Mongo: an unescaped search box lets a visitor
      // send a pathological regex and pin a CPU on every blog document.
      const pattern = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      query['$or'] = [
        { title: { $regex: pattern, $options: 'i' } },
        { meta_desc: { $regex: pattern, $options: 'i' } },
        { tags: { $regex: pattern, $options: 'i' } },
      ];
    }

    const docs = await blogsCollection().find(query).sort({ createdAt: -1 }).toArray();
    success(res, docs.map(toOverview), { dataKey: 'blogs' });
  }),
);

/**
 * Other blogs in the same category (overview shape).
 *
 * Declared before `/v1/blogs/:slug` so "related-blogs" is never matched as a
 * slug.
 */
blogsRouter.get(
  '/v1/related-blogs/:category',
  asyncHandler(async (req: Request, res) => {
    const docs = await blogsCollection()
      .find({ category: String(req.params['category']) })
      .sort({ createdAt: -1 })
      .limit(RELATED_LIMIT)
      .toArray();
    success(res, docs.map(toOverview));
  }),
);

/** A single full blog by slug. */
blogsRouter.get(
  '/v1/blogs/:slug',
  asyncHandler(async (req: Request, res) => {
    const doc = await blogsCollection().findOne({ slug: String(req.params['slug']) });
    if (!doc) {
      failure(res, 'Blog not found', 404);
      return;
    }
    success(res, jsonSafe(doc));
  }),
);

/** A single full blog by slug, optionally scoped to a category path. */
blogsRouter.get(
  '/v2/blogs/:slug',
  asyncHandler(async (req: Request, res) => {
    const query: Record<string, unknown> = { slug: String(req.params['slug']) };
    if (req.query['category']) query['category'] = String(req.query['category']);
    if (req.query['sub_category']) query['sub_category'] = String(req.query['sub_category']);

    const doc = await blogsCollection().findOne(query);
    if (!doc) {
      failure(res, 'Blog not found', 404);
      return;
    }
    success(res, jsonSafe(doc));
  }),
);
