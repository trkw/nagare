import { requireScope } from "./auth";
import type { Caller, Env } from "./env";
import { HttpError } from "./env";
import { discoverFeeds, type FetchLike } from "./feed/discover";
import type { ParsedItem } from "./feed/parse";
import { countInserted, insertItemsStatements, refreshFeed } from "./feed/refresh";

// Shared by the REST API and the MCP server so both behave the same.

export type FeedView = {
  id: number;
  kind: "rss" | "web" | "agent";
  url: string;
  title: string;
  site_url: string | null;
  folder: string | null;
  added_by: string | null;
  reason: string | null;
  notify: number;
  unread: number;
  last_error: string | null;
};

export async function listFeeds(db: D1Database): Promise<FeedView[]> {
  const { results } = await db
    .prepare(
      `SELECT f.id, f.kind, f.url, f.title, f.site_url, fo.name AS folder, t.name AS added_by, s.reason, f.notify,
         f.last_error,
         (SELECT COUNT(*) FROM entries e LEFT JOIN entry_states st ON st.entry_id = e.id
          WHERE e.feed_id = f.id AND COALESCE(st.read, 0) = 0) AS unread
       FROM feeds f
       JOIN subscriptions s ON s.feed_id = f.id
       LEFT JOIN folders fo ON fo.id = s.folder_id
       LEFT JOIN tokens t ON t.id = s.added_by
       ORDER BY fo.sort, fo.name, f.title`,
    )
    .all<FeedView>();
  return results;
}

export async function folderId(db: D1Database, name: string | undefined | null): Promise<number | null> {
  if (!name) return null;
  const row = await db
    .prepare("INSERT INTO folders (name) VALUES (?) ON CONFLICT (name) DO UPDATE SET name = excluded.name RETURNING id")
    .bind(name)
    .first<{ id: number }>();
  return row!.id;
}

async function checkFeedLimit(db: D1Database, caller: Caller): Promise<void> {
  if (caller.kind !== "agent" || caller.maxFeeds == null) return;
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM subscriptions WHERE added_by = ?")
    .bind(caller.id)
    .first<{ n: number }>();
  if ((row?.n ?? 0) >= caller.maxFeeds) {
    throw new HttpError(403, `feed limit reached (${caller.maxFeeds}) for ${caller.name}`);
  }
}

async function feedByUrl(db: D1Database, url: string): Promise<FeedView | undefined> {
  return (await listFeeds(db)).find((f) => f.url === url);
}

export type SubscribeInput = { url: string; folder?: string; reason?: string };

export async function subscribe(
  env: Env,
  caller: Caller,
  input: SubscribeInput,
  fetcher: FetchLike = fetch,
): Promise<{ feed: FeedView; created: boolean; added_entries: number }> {
  requireScope(caller, "subscribe");
  const candidates = await discoverFeeds(input.url, fetcher).catch((e: Error) => {
    throw new HttpError(422, `could not read ${input.url}: ${e.message}`);
  });
  const found = candidates[0];
  if (!found) throw new HttpError(422, `no feed found at ${input.url}`);

  const existing = await feedByUrl(env.DB, found.url);
  if (existing) return { feed: existing, created: false, added_entries: 0 };

  await checkFeedLimit(env.DB, caller);
  const now = Date.now();
  // Title stays empty so the first refresh fills it from the feed itself.
  const feed = await env.DB.prepare("INSERT INTO feeds (kind, url, title, created_at) VALUES ('rss', ?, '', ?) RETURNING id")
    .bind(found.url, now)
    .first<{ id: number }>();
  await env.DB.prepare("INSERT INTO subscriptions (feed_id, folder_id, added_by, reason, added_at) VALUES (?, ?, ?, ?, ?)")
    .bind(feed!.id, await folderId(env.DB, input.folder), caller.id, input.reason ?? null, now)
    .run();

  let added = 0;
  try {
    added = await refreshFeed(env, { id: feed!.id, url: found.url, etag: null, last_modified: null, error_count: 0 }, fetcher);
  } catch {
    // The error is recorded on the feed and shown as last_error; the subscription stays.
  }
  await env.DB.prepare("UPDATE feeds SET title = ? WHERE id = ? AND title = ''")
    .bind(found.title || found.url, feed!.id)
    .run();
  return { feed: (await feedByUrl(env.DB, found.url))!, created: true, added_entries: added };
}

async function ownedFeed(db: D1Database, caller: Caller, feedId: number) {
  const row = await db
    .prepare("SELECT f.id, f.kind, s.added_by FROM feeds f JOIN subscriptions s ON s.feed_id = f.id WHERE f.id = ?")
    .bind(feedId)
    .first<{ id: number; kind: string; added_by: number | null }>();
  if (!row) throw new HttpError(404, `feed ${feedId} not found`);
  if (caller.kind === "agent" && row.added_by !== caller.id) {
    throw new HttpError(403, `feed ${feedId} was not added by ${caller.name}`);
  }
  return row;
}

export async function unsubscribe(db: D1Database, caller: Caller, feedId: number): Promise<void> {
  requireScope(caller, "subscribe");
  await ownedFeed(db, caller, feedId);
  await db.prepare("DELETE FROM feeds WHERE id = ?").bind(feedId).run();
}

export async function createAgentFeed(
  db: D1Database,
  caller: Caller,
  input: { url: string; title: string; folder?: string; reason?: string },
): Promise<{ feed: FeedView; created: boolean }> {
  requireScope(caller, "subscribe");
  const existing = await feedByUrl(db, input.url);
  if (existing) {
    if (existing.kind !== "agent") throw new HttpError(409, `${input.url} is already an ${existing.kind} feed`);
    return { feed: existing, created: false };
  }
  await checkFeedLimit(db, caller);
  const now = Date.now();
  const feed = await db
    .prepare("INSERT INTO feeds (kind, url, title, site_url, created_at) VALUES ('agent', ?, ?, ?, ?) RETURNING id")
    .bind(input.url, input.title, input.url, now)
    .first<{ id: number }>();
  await db
    .prepare("INSERT INTO subscriptions (feed_id, folder_id, added_by, reason, added_at) VALUES (?, ?, ?, ?, ?)")
    .bind(feed!.id, await folderId(db, input.folder), caller.id, input.reason ?? null, now)
    .run();
  return { feed: (await feedByUrl(db, input.url))!, created: true };
}

export type ItemInput = {
  guid?: string;
  url?: string;
  title: string;
  content?: string;
  author?: string;
  published_at?: string | number;
};

export async function addItems(db: D1Database, caller: Caller, feedId: number, items: ItemInput[]): Promise<{ added: number }> {
  requireScope(caller, "write");
  const feed = await ownedFeed(db, caller, feedId);
  if (feed.kind !== "agent") throw new HttpError(409, `feed ${feedId} is not an agent feed`);
  if (items.length === 0) return { added: 0 };
  if (items.length > 100) throw new HttpError(400, "at most 100 items per call");

  const now = Date.now();
  const parsed: ParsedItem[] = items.map((it) => {
    if (!it.title && !it.content) throw new HttpError(400, "each item needs a title or content");
    const published = it.published_at == null ? NaN : new Date(it.published_at).getTime();
    return {
      guid: it.guid ?? it.url ?? `${it.title}|${published}`,
      url: it.url ?? null,
      title: it.title ?? "",
      author: it.author ?? null,
      content: it.content ?? null,
      publishedAt: Number.isNaN(published) ? now : published,
    };
  });
  const results = await db.batch(insertItemsStatements(db, feedId, parsed, now));
  return { added: countInserted(results) };
}

export type EntryView = {
  id: number;
  feed_id: number;
  feed_title: string;
  url: string | null;
  title: string;
  author: string | null;
  content?: string | null;
  published_at: number;
  read: number;
  starred: number;
};

export type EntryFilter = {
  feed?: number;
  folder?: string;
  unread?: boolean;
  starred?: boolean;
  q?: string;
  before?: number;
  since?: number;
  limit?: number;
  withContent?: boolean;
};

export async function listEntries(db: D1Database, f: EntryFilter): Promise<EntryView[]> {
  const where: string[] = [];
  const args: unknown[] = [];
  let from = "entries e";
  if (f.q) {
    const q = f.q.trim();
    if ([...q].length >= 3) {
      from = "entries_fts JOIN entries e ON e.id = entries_fts.rowid";
      where.push("entries_fts MATCH ?");
      args.push(`"${q.replace(/"/g, '""')}"`);
    } else {
      where.push("(e.title LIKE ? OR e.content LIKE ?)");
      args.push(`%${q}%`, `%${q}%`);
    }
  }
  if (f.feed != null) where.push("e.feed_id = ?"), args.push(f.feed);
  if (f.folder) where.push("fo.name = ?"), args.push(f.folder);
  if (f.unread) where.push("COALESCE(st.read, 0) = 0");
  if (f.starred) where.push("COALESCE(st.starred, 0) = 1");
  if (f.before != null) where.push("e.published_at < ?"), args.push(f.before);
  if (f.since != null) where.push("e.created_at > ?"), args.push(f.since);
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 200);

  const { results } = await db
    .prepare(
      `SELECT e.id, e.feed_id, fd.title AS feed_title, e.url, e.title, e.author,
         ${f.withContent ? "COALESCE(e.full_content, e.content) AS content," : ""}
         e.published_at, COALESCE(st.read, 0) AS read, COALESCE(st.starred, 0) AS starred
       FROM ${from}
       JOIN feeds fd ON fd.id = e.feed_id
       JOIN subscriptions s ON s.feed_id = e.feed_id
       LEFT JOIN folders fo ON fo.id = s.folder_id
       LEFT JOIN entry_states st ON st.entry_id = e.id
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY e.published_at DESC LIMIT ${limit}`,
    )
    .bind(...args)
    .all<EntryView>();
  return results;
}

export async function getEntry(db: D1Database, id: number): Promise<EntryView> {
  const row = await db
    .prepare(
      `SELECT e.id, e.feed_id, fd.title AS feed_title, e.url, e.title, e.author,
         COALESCE(e.full_content, e.content) AS content, e.published_at,
         COALESCE(st.read, 0) AS read, COALESCE(st.starred, 0) AS starred
       FROM entries e JOIN feeds fd ON fd.id = e.feed_id LEFT JOIN entry_states st ON st.entry_id = e.id
       WHERE e.id = ?`,
    )
    .bind(id)
    .first<EntryView>();
  if (!row) throw new HttpError(404, `entry ${id} not found`);
  return row;
}

export async function setEntryState(
  db: D1Database,
  caller: Caller,
  ids: number[],
  state: { read?: boolean; starred?: boolean },
): Promise<{ updated: number }> {
  requireScope(caller, "write");
  if (state.read == null && state.starred == null) throw new HttpError(400, "give read and/or starred");
  if (ids.length > 1000) throw new HttpError(400, "at most 1000 ids per call");
  const now = Date.now();
  const read = state.read == null ? null : state.read ? 1 : 0;
  const starred = state.starred == null ? null : state.starred ? 1 : 0;
  const results = await db.batch(
    ids.map((id) =>
      db
        .prepare(
          `INSERT INTO entry_states (entry_id, read, starred, updated_at)
           SELECT id, COALESCE(?1, 0), COALESCE(?2, 0), ?3 FROM entries WHERE id = ?4
           ON CONFLICT (entry_id) DO UPDATE SET
             read = COALESCE(?1, read), starred = COALESCE(?2, starred), updated_at = ?3`,
        )
        .bind(read, starred, now, id),
    ),
  );
  return { updated: results.reduce((n, r) => n + (r.meta.changes ?? 0), 0) };
}

/** Everything a client needs to catch up since its last sync. */
export async function sync(db: D1Database, since: number) {
  const serverTime = Date.now();
  const [feeds, entries, states] = await Promise.all([
    listFeeds(db),
    listEntries(db, { since, limit: 200, withContent: true }),
    db
      .prepare("SELECT entry_id, read, starred, updated_at FROM entry_states WHERE updated_at > ? ORDER BY updated_at LIMIT 5000")
      .bind(since)
      .all(),
  ]);
  return { server_time: serverTime, feeds, entries, states: states.results, has_more: entries.length === 200 };
}

export async function createHandoff(
  db: D1Database,
  caller: Caller,
  input: { entry_ids: number[]; note?: string; to_agent?: string },
): Promise<{ id: number }> {
  requireScope(caller, "write");
  if (input.entry_ids.length === 0 && !input.note) throw new HttpError(400, "give entry_ids and/or a note");
  let to: number | null = null;
  if (input.to_agent) {
    const row = await db
      .prepare("SELECT id FROM tokens WHERE name = ? AND kind = 'agent'")
      .bind(input.to_agent)
      .first<{ id: number }>();
    if (!row) throw new HttpError(404, `agent ${input.to_agent} not found`);
    to = row.id;
  }
  const row = await db
    .prepare("INSERT INTO handoffs (to_agent, entry_ids, note, created_at) VALUES (?, ?, ?, ?) RETURNING id")
    .bind(to, JSON.stringify(input.entry_ids), input.note ?? null, Date.now())
    .first<{ id: number }>();
  return { id: row!.id };
}

/** Pending handoffs for an agent, with their entries; marks them picked up. */
export async function takeHandoffs(db: D1Database, caller: Caller) {
  requireScope(caller, "read");
  const { results } = await db
    .prepare(
      `SELECT id, entry_ids, note, created_at FROM handoffs
       WHERE picked_up_at IS NULL AND (to_agent IS NULL OR to_agent = ?) ORDER BY created_at LIMIT 20`,
    )
    .bind(caller.id)
    .all<{ id: number; entry_ids: string; note: string | null; created_at: number }>();
  const out = [];
  for (const h of results) {
    const ids = JSON.parse(h.entry_ids) as number[];
    const entries = await Promise.all(ids.map((id) => getEntry(db, id).catch(() => null)));
    out.push({ id: h.id, note: h.note, created_at: h.created_at, entries: entries.filter((e) => e != null) });
  }
  if (results.length) {
    await db.batch(
      results.map((h) => db.prepare("UPDATE handoffs SET picked_up_at = ? WHERE id = ?").bind(Date.now(), h.id)),
    );
  }
  return out;
}
