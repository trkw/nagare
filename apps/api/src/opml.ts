import { XMLParser } from "fast-xml-parser";
import { requireScope } from "./auth";
import type { Caller } from "./env";
import { HttpError } from "./env";
import { folderId, listFeeds } from "./service";

type Outline = Record<string, unknown> & { outline?: Outline[] };

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  isArray: (name) => name === "outline",
});

export type OpmlFeed = { url: string; title: string; folder: string | null };

export function parseOpml(body: string): OpmlFeed[] {
  let doc: { opml?: { body?: Outline } };
  try {
    doc = parser.parse(body);
  } catch (e) {
    throw new HttpError(400, `invalid OPML: ${(e as Error).message}`);
  }
  const out: OpmlFeed[] = [];
  const walk = (outlines: Outline[] | undefined, folder: string | null) => {
    for (const o of outlines ?? []) {
      const title = String(o.title ?? o.text ?? "");
      if (typeof o.xmlUrl === "string") out.push({ url: o.xmlUrl, title, folder });
      else walk(o.outline, title || folder);
    }
  };
  walk(doc.opml?.body?.outline, null);
  return out;
}

/** Adds every feed in the OPML; they are fetched by the next cron run. */
export async function importOpml(db: D1Database, caller: Caller, body: string): Promise<{ added: number; skipped: number }> {
  requireScope(caller, "subscribe");
  const feeds = parseOpml(body);
  const now = Date.now();
  let added = 0;
  for (const f of feeds) {
    const row = await db
      .prepare("INSERT OR IGNORE INTO feeds (kind, url, title, created_at) VALUES ('rss', ?, ?, ?) RETURNING id")
      .bind(f.url, f.title, now)
      .first<{ id: number }>();
    if (!row) continue;
    await db
      .prepare("INSERT INTO subscriptions (feed_id, folder_id, added_by, added_at) VALUES (?, ?, ?, ?)")
      .bind(row.id, await folderId(db, f.folder), caller.id, now)
      .run();
    added++;
  }
  return { added, skipped: feeds.length - added };
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export async function exportOpml(db: D1Database): Promise<string> {
  const feeds = (await listFeeds(db)).filter((f) => f.kind === "rss");
  const byFolder = new Map<string, typeof feeds>();
  for (const f of feeds) {
    const key = f.folder ?? "";
    byFolder.set(key, [...(byFolder.get(key) ?? []), f]);
  }
  const line = (f: (typeof feeds)[number]) =>
    `<outline type="rss" text="${esc(f.title)}" title="${esc(f.title)}" xmlUrl="${esc(f.url)}"${
      f.site_url ? ` htmlUrl="${esc(f.site_url)}"` : ""
    }/>`;
  const body = [...byFolder]
    .map(([folder, list]) =>
      folder
        ? `<outline text="${esc(folder)}" title="${esc(folder)}">\n${list.map((f) => `  ${line(f)}`).join("\n")}\n</outline>`
        : list.map(line).join("\n"),
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n<head><title>Nagare</title></head>\n<body>\n${body}\n</body>\n</opml>\n`;
}
