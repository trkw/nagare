import { Hono } from "hono";
import { authenticate, requireScope } from "../auth";
import type { Caller, Env } from "../env";
import { HttpError } from "../env";
import { refreshFeed } from "../feed/refresh";
import { exportOpml, importOpml } from "../opml";
import * as svc from "../service";

type App = { Bindings: Env; Variables: { caller: Caller } };

const int = (v: string | undefined) => {
  if (v == null || v === "") return undefined;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new HttpError(400, `not an integer: ${v}`);
  return n;
};

async function json<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, "body must be JSON");
  }
}

export const api = new Hono<App>();

api.use(async (c, next) => {
  c.set("caller", await authenticate(c.env, c.req.header("authorization"), c.executionCtx));
  await next();
});

api.get("/me", (c) => {
  const { name, kind, scopes } = c.get("caller");
  return c.json({ name, kind, scopes: [...scopes] });
});

api.get("/feeds", async (c) => {
  requireScope(c.get("caller"), "read");
  return c.json(await svc.listFeeds(c.env.DB));
});

api.post("/feeds", async (c) => {
  const body = await json<svc.SubscribeInput>(c.req.raw);
  if (!body.url) throw new HttpError(400, "url is required");
  const result = await svc.subscribe(c.env, c.get("caller"), body);
  return c.json(result, result.created ? 201 : 200);
});

api.delete("/feeds/:id", async (c) => {
  await svc.unsubscribe(c.env.DB, c.get("caller"), int(c.req.param("id"))!);
  return c.body(null, 204);
});

api.post("/feeds/:id/refresh", async (c) => {
  requireScope(c.get("caller"), "write");
  const feed = await c.env.DB.prepare("SELECT id, url, etag, last_modified, error_count FROM feeds WHERE id = ? AND kind = 'rss'")
    .bind(int(c.req.param("id"))!)
    .first<{ id: number; url: string; etag: string | null; last_modified: string | null; error_count: number }>();
  if (!feed) throw new HttpError(404, "rss feed not found");
  const added = await refreshFeed(c.env, feed).catch((e: Error) => {
    throw new HttpError(502, e.message);
  });
  return c.json({ added });
});

api.post("/agent-feeds", async (c) => {
  const body = await json<{ url: string; title: string; folder?: string; reason?: string }>(c.req.raw);
  if (!body.url || !body.title) throw new HttpError(400, "url and title are required");
  const result = await svc.createAgentFeed(c.env.DB, c.get("caller"), body);
  return c.json(result, result.created ? 201 : 200);
});

api.post("/agent-feeds/:id/items", async (c) => {
  const body = await json<{ items: svc.ItemInput[] }>(c.req.raw);
  return c.json(await svc.addItems(c.env.DB, c.get("caller"), int(c.req.param("id"))!, body.items ?? []));
});

api.get("/entries", async (c) => {
  requireScope(c.get("caller"), "read");
  const q = c.req.query();
  return c.json(
    await svc.listEntries(c.env.DB, {
      feed: int(q.feed),
      folder: q.folder,
      unread: q.unread === "1" || q.unread === "true",
      starred: q.starred === "1" || q.starred === "true",
      q: q.q,
      before: int(q.before),
      beforeId: int(q.before_id),
      limit: int(q.limit),
      withContent: q.content === "1" || q.content === "true",
    }),
  );
});

api.get("/entries/:id", async (c) => {
  requireScope(c.get("caller"), "read");
  return c.json(await svc.getEntry(c.env.DB, int(c.req.param("id"))!));
});

api.post("/entries/state", async (c) => {
  const body = await json<{ ids: number[]; read?: boolean; starred?: boolean }>(c.req.raw);
  if (!Array.isArray(body.ids)) throw new HttpError(400, "ids must be an array");
  return c.json(await svc.setEntryState(c.env.DB, c.get("caller"), body.ids, body));
});

api.get("/sync", async (c) => {
  requireScope(c.get("caller"), "read");
  return c.json(await svc.sync(c.env.DB, c.req.query("cursor")));
});

api.post("/handoffs", async (c) => {
  const body = await json<{ entry_ids: number[]; note?: string; to_agent?: string }>(c.req.raw);
  return c.json(await svc.createHandoff(c.env.DB, c.get("caller"), { ...body, entry_ids: body.entry_ids ?? [] }), 201);
});

api.post("/opml", async (c) => c.json(await importOpml(c.env.DB, c.get("caller"), await c.req.text())));

api.get("/opml", async (c) => {
  requireScope(c.get("caller"), "read");
  return c.body(await exportOpml(c.env.DB), 200, { "content-type": "text/x-opml; charset=utf-8" });
});
