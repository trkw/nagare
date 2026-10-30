import { loadCredential, withCredential } from "../credentials";
import type { Env } from "../env";
import { notifyNewEntries } from "../push";
import { USER_AGENT, type FetchLike } from "./discover";
import { parseFeed, type ParsedItem } from "./parse";
import { extractWebItems } from "./web";

const BASE_INTERVAL = 30 * 60_000;
const MAX_INTERVAL = 24 * 60 * 60_000;
// Workers allow 6 open connections at a time and 50 subrequests per invocation on the free plan.
const CONCURRENCY = 6;
const PER_RUN = 40;

/** Ids from insertItemsStatements results, i.e. the entries that were actually new. */
export function insertedIds(results: D1Result[]): number[] {
  return results.flatMap((r) => (r.results as { id: number }[]).map((row) => row.id));
}

export type FeedRow = {
  id: number;
  kind: "rss" | "web";
  url: string;
  selector: string | null;
  credential_id: number | null;
  etag: string | null;
  last_modified: string | null;
  error_count: number;
};

const FEED_COLUMNS = "id, kind, url, selector, credential_id, etag, last_modified, error_count";

/** A feed that Nagare fetches itself (RSS or a watched web page); null for agent feeds. */
export async function fetchableFeed(db: D1Database, id: number): Promise<FeedRow | null> {
  return db.prepare(`SELECT ${FEED_COLUMNS} FROM feeds WHERE id = ? AND kind IN ('rss', 'web')`).bind(id).first<FeedRow>();
}

export function nextFetchDelay(errorCount: number): number {
  return Math.min(BASE_INTERVAL * 2 ** errorCount, MAX_INTERVAL);
}

export function insertItemsStatements(db: D1Database, feedId: number, items: ParsedItem[], now: number) {
  return items.map((it) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO entries (feed_id, guid, url, title, author, content, published_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .bind(feedId, it.guid, it.url, it.title, it.author, it.content, it.publishedAt ?? now, now),
  );
}

/**
 * Fetches one feed or watched page, stores new entries and schedules the next fetch. Returns the number of
 * new entries. With notify, a feed that has notifications on pushes its new entries to the owner's devices.
 */
export async function refreshFeed(
  env: Env,
  feed: FeedRow,
  fetcher: FetchLike = fetch,
  opts: { notify?: boolean } = {},
): Promise<number> {
  const now = Date.now();
  const headers: Record<string, string> = { "user-agent": USER_AGENT };
  if (feed.etag) headers["if-none-match"] = feed.etag;
  if (feed.last_modified) headers["if-modified-since"] = feed.last_modified;

  try {
    const fetchWith = withCredential(fetcher, await loadCredential(env, feed.credential_id));
    const res = await fetchWith(feed.url, { headers });
    if (res.status === 304) {
      await env.DB.prepare(
        "UPDATE feeds SET last_fetched_at = ?, next_fetch_at = ?, error_count = 0, last_error = NULL WHERE id = ?",
      )
        .bind(now, now + BASE_INTERVAL, feed.id)
        .run();
      return 0;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const body = await res.text();
    const parsed = feed.kind === "web" ? extractWebItems(body, res.url || feed.url, feed.selector) : parseFeed(body, res.url || feed.url);
    if (feed.kind === "web") {
      if (parsed.items.length === 0) throw new Error(feed.selector ? `nothing matches ${feed.selector}` : "no items found on the page");
      // Page items rarely carry dates; inserting bottom-up keeps the page's order in the list.
      parsed.items.reverse();
    }
    const results = await env.DB.batch([
      ...insertItemsStatements(env.DB, feed.id, parsed.items, now),
      env.DB.prepare(
        `UPDATE feeds SET title = CASE WHEN title = '' THEN ? ELSE title END, site_url = COALESCE(?, site_url),
           etag = ?, last_modified = ?, last_fetched_at = ?, next_fetch_at = ?, error_count = 0, last_error = NULL
         WHERE id = ?`,
      ).bind(
        parsed.title,
        parsed.siteUrl,
        res.headers.get("etag"),
        res.headers.get("last-modified"),
        now,
        now + BASE_INTERVAL,
        feed.id,
      ),
    ]);
    const ids = insertedIds(results.slice(0, -1));
    if (opts.notify && ids.length > 0) {
      // A push failure is recorded on the device, never on the feed.
      await notifyNewEntries(env, feed.id, ids).catch((e) => console.error("push failed", e));
    }
    return ids.length;
  } catch (e) {
    const errors = feed.error_count + 1;
    await env.DB.prepare(
      "UPDATE feeds SET last_fetched_at = ?, next_fetch_at = ?, error_count = ?, last_error = ? WHERE id = ?",
    )
      .bind(now, now + nextFetchDelay(errors), errors, String((e as Error).message ?? e), feed.id)
      .run();
    throw e;
  }
}

/** Cron entry point: refreshes the feeds and watched pages that are due. */
export async function refreshDueFeeds(env: Env, fetcher: FetchLike = fetch): Promise<{ fetched: number; added: number; failed: number }> {
  const { results: due } = await env.DB.prepare(
    `SELECT ${FEED_COLUMNS} FROM feeds
     WHERE kind IN ('rss', 'web') AND next_fetch_at <= ? ORDER BY next_fetch_at LIMIT ?`,
  )
    .bind(Date.now(), PER_RUN)
    .all<FeedRow>();

  let added = 0;
  let failed = 0;
  for (let i = 0; i < due.length; i += CONCURRENCY) {
    const settled = await Promise.allSettled(due.slice(i, i + CONCURRENCY).map((f) => refreshFeed(env, f, fetcher, { notify: true })));
    for (const s of settled) {
      if (s.status === "fulfilled") added += s.value;
      else failed++;
    }
  }
  return { fetched: due.length, added, failed };
}
