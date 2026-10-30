import { requireScope } from "./auth";
import { credentialIdByName, loadCredential, withCredential } from "./credentials";
import type { Caller, Env } from "./env";
import { HttpError } from "./env";
import { discoverFeeds, USER_AGENT, type FetchLike } from "./feed/discover";
import type { ParsedItem } from "./feed/parse";
import { fetchableFeed, insertedIds, insertItemsStatements, refreshFeed } from "./feed/refresh";
import { extractWebItems } from "./feed/web";
import { notifyNewEntries } from "./push";

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
  selector: string | null;
  credential: string | null;
  notify: number;
  unread: number;
  last_error: string | null;
};

export async function listFeeds(db: D1Database): Promise<FeedView[]> {
  const { results } = await db
    .prepare(
      `SELECT f.id, f.kind, f.url, f.title, f.site_url, fo.name AS folder, t.name AS added_by, s.reason,
         f.selector, c.name AS credential, f.notify, f.last_error,
         (SELECT COUNT(*) FROM entries e LEFT JOIN entry_states st ON st.entry_id = e.id
          WHERE e.feed_id = f.id AND COALESCE(st.read, 0) = 0) AS unread
       FROM feeds f
       JOIN subscriptions s ON s.feed_id = f.id
       LEFT JOIN folders fo ON fo.id = s.folder_id
       LEFT JOIN tokens t ON t.id = s.added_by
       LEFT JOIN credentials c ON c.id = f.credential_id
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

export type SubscribeInput = { url: string; folder?: string; reason?: string; credential?: string };

function httpUrl(url: string): URL {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new HttpError(400, `not a URL: ${url}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new HttpError(400, "only http(s) URLs are supported");
  return u;
}

export async function subscribe(
  env: Env,
  caller: Caller,
  input: SubscribeInput,
  fetcher: FetchLike = fetch,
): Promise<{ feed: FeedView; created: boolean; added_entries: number }> {
  requireScope(caller, "subscribe");
  httpUrl(input.url);
  const credentialId = input.credential ? await credentialIdByName(env.DB, caller, input.credential, input.url) : null;
  const fetchWith = withCredential(fetcher, await loadCredential(env, credentialId));
  const candidates = await discoverFeeds(input.url, fetchWith).catch((e: Error) => {
    throw new HttpError(422, `could not read ${input.url}: ${e.message}`);
  });
  const found = candidates[0];
  if (!found) throw new HttpError(422, `no feed found at ${input.url}`);
  if (credentialId != null && new URL(found.url).hostname !== new URL(input.url).hostname) {
    throw new HttpError(422, `the feed is on ${new URL(found.url).hostname}, where credential ${input.credential} is not sent`);
  }

  const existing = await feedByUrl(env.DB, found.url);
  if (existing) return { feed: existing, created: false, added_entries: 0 };

  await checkFeedLimit(env.DB, caller);
  const now = Date.now();
  // Title stays empty so the first refresh fills it from the feed itself.
  const feed = await env.DB.prepare(
    "INSERT INTO feeds (kind, url, title, credential_id, created_at) VALUES ('rss', ?, '', ?, ?) RETURNING id",
  )
    .bind(found.url, credentialId, now)
    .first<{ id: number }>();
  await env.DB.prepare("INSERT INTO subscriptions (feed_id, folder_id, added_by, reason, added_at) VALUES (?, ?, ?, ?, ?)")
    .bind(feed!.id, await folderId(env.DB, input.folder), caller.id, input.reason ?? null, now)
    .run();

  const added = await firstRefresh(env, feed!.id, fetcher);
  await env.DB.prepare("UPDATE feeds SET title = ? WHERE id = ? AND title = ''")
    .bind(found.title || found.url, feed!.id)
    .run();
  return { feed: (await feedByUrl(env.DB, found.url))!, created: true, added_entries: added };
}

async function firstRefresh(env: Env, feedId: number, fetcher: FetchLike): Promise<number> {
  try {
    return await refreshFeed(env, (await fetchableFeed(env.DB, feedId))!, fetcher);
  } catch {
    // The error is recorded on the feed and shown as last_error; the subscription stays.
    return 0;
  }
}

export type WebFeedInput = {
  url: string;
  selector?: string;
  title?: string;
  folder?: string;
  reason?: string;
  credential?: string;
  /** Only show what would be picked up, without saving anything. */
  dry_run?: boolean;
};

/** Watches a page without a feed: each item the page lists (or each change to it) becomes an entry. */
export async function createWebFeed(env: Env, caller: Caller, input: WebFeedInput, fetcher: FetchLike = fetch) {
  requireScope(caller, "subscribe");
  const url = httpUrl(input.url).toString();
  const selector = input.selector?.trim() || null;
  const credentialId = input.credential ? await credentialIdByName(env.DB, caller, input.credential, url) : null;

  if (input.dry_run) {
    const fetchWith = withCredential(fetcher, await loadCredential(env, credentialId));
    const res = await fetchWith(url, { headers: { "user-agent": USER_AGENT, accept: "text/html" } }).catch((e: Error) => {
      throw new HttpError(422, `could not read ${url}: ${e.message}`);
    });
    if (!res.ok) throw new HttpError(422, `HTTP ${res.status} from ${url}`);
    let page;
    try {
      page = extractWebItems(await res.text(), res.url || url, selector);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    return { title: page.title, items: page.items.map(({ url, title }) => ({ url, title })) };
  }

  const existing = await feedByUrl(env.DB, url);
  if (existing) {
    if (existing.kind !== "web") throw new HttpError(409, `${url} is already an ${existing.kind} feed`);
    return { feed: existing, created: false, added_entries: 0 };
  }
  await checkFeedLimit(env.DB, caller);
  const now = Date.now();
  const feed = await env.DB.prepare(
    `INSERT INTO feeds (kind, url, title, site_url, selector, credential_id, created_at)
     VALUES ('web', ?, ?, ?, ?, ?, ?) RETURNING id`,
  )
    .bind(url, input.title?.trim() ?? "", url, selector, credentialId, now)
    .first<{ id: number }>();
  await env.DB.prepare("INSERT INTO subscriptions (feed_id, folder_id, added_by, reason, added_at) VALUES (?, ?, ?, ?, ?)")
    .bind(feed!.id, await folderId(env.DB, input.folder), caller.id, input.reason ?? null, now)
    .run();
  const added = await firstRefresh(env, feed!.id, fetcher);
  await env.DB.prepare("UPDATE feeds SET title = ? WHERE id = ? AND title = ''").bind(url, feed!.id).run();
  return { feed: (await feedByUrl(env.DB, url))!, created: true, added_entries: added };
}

export type FeedUpdate = {
  title?: string;
  folder?: string | null;
  selector?: string | null;
  credential?: string | null;
  notify?: boolean;
  auto_translate?: boolean;
};

export async function updateFeed(env: Env, caller: Caller, feedId: number, input: FeedUpdate): Promise<FeedView> {
  requireScope(caller, "subscribe");
  const feed = await ownedFeed(env.DB, caller, feedId);
  const sets: string[] = [];
  const args: unknown[] = [];
  if (input.title !== undefined) sets.push("title = ?"), args.push(input.title.trim());
  if (input.notify !== undefined) sets.push("notify = ?"), args.push(input.notify ? 1 : 0);
  if (input.auto_translate !== undefined) sets.push("auto_translate = ?"), args.push(input.auto_translate ? 1 : 0);
  if (input.selector !== undefined) {
    if (feed.kind !== "web") throw new HttpError(409, "only web feeds have a selector");
    sets.push("selector = ?", "next_fetch_at = 0"), args.push(input.selector?.trim() || null);
  }
  if (input.credential !== undefined) {
    if (feed.kind === "agent") throw new HttpError(409, "agent feeds are not fetched, so they take no credential");
    const url = (await env.DB.prepare("SELECT url FROM feeds WHERE id = ?").bind(feedId).first<{ url: string }>())!.url;
    const id = input.credential ? await credentialIdByName(env.DB, caller, input.credential, url) : null;
    sets.push("credential_id = ?", "next_fetch_at = 0"), args.push(id);
  }
  // A changed fetch setting invalidates the cached validators, so the next run fetches the page in full.
  if (sets.some((s) => s.startsWith("next_fetch_at"))) sets.push("etag = NULL", "last_modified = NULL", "error_count = 0");
  const statements = [];
  if (sets.length) {
    statements.push(env.DB.prepare(`UPDATE feeds SET ${[...new Set(sets)].join(", ")} WHERE id = ?`).bind(...args, feedId));
  }
  if (input.folder !== undefined) {
    statements.push(
      env.DB.prepare("UPDATE subscriptions SET folder_id = ? WHERE feed_id = ?").bind(await folderId(env.DB, input.folder), feedId),
    );
  }
  if (statements.length) await env.DB.batch(statements);
  return (await listFeeds(env.DB)).find((f) => f.id === feedId)!;
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

export async function addItems(env: Env, caller: Caller, feedId: number, items: ItemInput[]): Promise<{ added: number }> {
  const db = env.DB;
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
  const ids = insertedIds(await db.batch(insertItemsStatements(db, feedId, parsed, now)));
  await notifyNewEntries(env, feedId, ids).catch((e) => console.error("push failed", e));
  return { added: ids.length };
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
  /** Cursor: entries older than (before, beforeId) in the list order. */
  before?: number;
  beforeId?: number;
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
  if (f.before != null) {
    if (f.beforeId != null) {
      where.push("(e.published_at < ? OR (e.published_at = ? AND e.id < ?))");
      args.push(f.before, f.before, f.beforeId);
    } else {
      where.push("e.published_at < ?");
      args.push(f.before);
    }
  }
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
       ORDER BY e.published_at DESC, e.id DESC LIMIT ${limit}`,
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
          `INSERT INTO entry_states (entry_id, read, starred, version, updated_at)
           SELECT id, COALESCE(?1, 0), COALESCE(?2, 0), (SELECT COALESCE(MAX(version), 0) + 1 FROM entry_states), ?3
           FROM entries WHERE id = ?4
           ON CONFLICT (entry_id) DO UPDATE SET
             read = COALESCE(?1, read), starred = COALESCE(?2, starred),
             version = excluded.version, updated_at = ?3`,
        )
        .bind(read, starred, now, id),
    ),
  );
  return { updated: results.reduce((n, r) => n + (r.meta.changes ?? 0), 0) };
}

const SYNC_ENTRIES = 200;
const SYNC_STATES = 1000;

/** Sync cursor "<last entry id>.<last state version>"; empty means from the start. */
export function parseSyncCursor(cursor: string | undefined): { entry: number; version: number } {
  if (!cursor) return { entry: 0, version: 0 };
  const m = cursor.match(/^(\d+)\.(\d+)$/);
  if (!m) throw new HttpError(400, `invalid sync cursor: ${cursor}`);
  return { entry: Number(m[1]), version: Number(m[2]) };
}

/**
 * Changes since the cursor, oldest first. Call again with the returned cursor while
 * has_more is true; keep the last cursor for the next sync.
 */
export async function sync(db: D1Database, cursor: string | undefined) {
  const from = parseSyncCursor(cursor);
  const [feeds, entries, states] = await Promise.all([
    listFeeds(db),
    db
      .prepare(
        `SELECT e.id, e.feed_id, fd.title AS feed_title, e.url, e.title, e.author,
           COALESCE(e.full_content, e.content) AS content, e.published_at,
           COALESCE(st.read, 0) AS read, COALESCE(st.starred, 0) AS starred
         FROM entries e JOIN feeds fd ON fd.id = e.feed_id LEFT JOIN entry_states st ON st.entry_id = e.id
         WHERE e.id > ? ORDER BY e.id LIMIT ?`,
      )
      .bind(from.entry, SYNC_ENTRIES)
      .all<EntryView>(),
    db
      .prepare("SELECT entry_id, read, starred, version FROM entry_states WHERE version > ? ORDER BY version LIMIT ?")
      .bind(from.version, SYNC_STATES)
      .all<{ entry_id: number; read: number; starred: number; version: number }>(),
  ]);
  const lastEntry = entries.results.at(-1)?.id ?? from.entry;
  const lastVersion = states.results.at(-1)?.version ?? from.version;
  return {
    feeds,
    entries: entries.results,
    states: states.results,
    cursor: `${lastEntry}.${lastVersion}`,
    has_more: entries.results.length === SYNC_ENTRIES || states.results.length === SYNC_STATES,
  };
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

/** Pending handoffs for an agent, with their entries. Claimed atomically, so each is delivered once. */
export async function takeHandoffs(db: D1Database, caller: Caller) {
  requireScope(caller, "read");
  const { results } = await db
    .prepare(
      `UPDATE handoffs SET picked_up_at = ?1
       WHERE id IN (SELECT id FROM handoffs
                    WHERE picked_up_at IS NULL AND (to_agent IS NULL OR to_agent = ?2) ORDER BY created_at LIMIT 20)
         AND picked_up_at IS NULL
       RETURNING id, entry_ids, note, created_at`,
    )
    .bind(Date.now(), caller.id)
    .all<{ id: number; entry_ids: string; note: string | null; created_at: number }>();
  const out = [];
  for (const h of results.sort((a, b) => a.created_at - b.created_at)) {
    const ids = JSON.parse(h.entry_ids) as number[];
    const entries = await Promise.all(ids.map((id) => getEntry(db, id).catch(() => null)));
    out.push({ id: h.id, note: h.note, created_at: h.created_at, entries: entries.filter((e) => e != null) });
  }
  return out;
}
