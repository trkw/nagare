import { XMLParser } from "fast-xml-parser";

export type ParsedItem = {
  guid: string;
  url: string | null;
  title: string;
  author: string | null;
  content: string | null;
  publishedAt: number | null;
};

export type ParsedFeed = {
  title: string;
  siteUrl: string | null;
  items: ParsedItem[];
};

export class FeedParseError extends Error {}

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: true,
  htmlEntities: true,
  isArray: (name) => ["item", "entry", "link", "author", "category"].includes(name),
});

type Node = Record<string, unknown>;

function text(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) return text(v[0]);
  if (typeof v === "object") return text((v as Node)["#text"]);
  return "";
}

function orNull(s: string): string | null {
  return s === "" ? null : s;
}

function date(...candidates: unknown[]): number | null {
  for (const c of candidates) {
    const t = Date.parse(text(c));
    if (!Number.isNaN(t)) return t;
  }
  return null;
}

function absolute(url: string | null, base: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url, base ?? undefined).toString();
  } catch {
    return url;
  }
}

function fallbackGuid(item: Omit<ParsedItem, "guid">): string {
  return item.url ?? `${item.title}|${item.publishedAt ?? ""}`;
}

export function parseFeed(body: string, feedUrl: string | null = null): ParsedFeed {
  const trimmed = body.trimStart();
  if (trimmed.startsWith("{")) return parseJsonFeed(trimmed, feedUrl);

  let doc: Node;
  try {
    doc = xml.parse(trimmed) as Node;
  } catch (e) {
    throw new FeedParseError(`invalid XML: ${(e as Error).message}`);
  }
  if (doc.rss) return parseRss(doc.rss as Node, feedUrl);
  if (doc["rdf:RDF"]) return parseRdf(doc["rdf:RDF"] as Node, feedUrl);
  if (doc.feed) return parseAtom(doc.feed as Node, feedUrl);
  throw new FeedParseError("not an RSS, Atom or JSON feed");
}

function rssItem(it: Node, base: string | null): ParsedItem {
  const url = absolute(orNull(text(it.link)), base);
  const partial = {
    url,
    title: text(it.title),
    author: orNull(text(it["dc:creator"]) || text(it.author)),
    content: orNull(text(it["content:encoded"]) || text(it.description)),
    publishedAt: date(it.pubDate, it["dc:date"]),
  };
  return { guid: text(it.guid) || fallbackGuid(partial), ...partial };
}

function parseRss(rss: Node, feedUrl: string | null): ParsedFeed {
  const ch = (rss.channel ?? {}) as Node;
  const siteUrl = absolute(orNull(text(ch.link)), feedUrl);
  const items = ((ch.item as Node[] | undefined) ?? []).map((it) => rssItem(it, siteUrl ?? feedUrl));
  return { title: text(ch.title), siteUrl, items };
}

function parseRdf(rdf: Node, feedUrl: string | null): ParsedFeed {
  const ch = (rdf.channel ?? {}) as Node;
  const siteUrl = absolute(orNull(text(ch.link)), feedUrl);
  const items = ((rdf.item as Node[] | undefined) ?? []).map((it) => rssItem(it, siteUrl ?? feedUrl));
  return { title: text(ch.title), siteUrl, items };
}

function atomLink(links: unknown, base: string | null): string | null {
  const list = (links as Node[] | undefined) ?? [];
  const alt = list.find((l) => !l["@_rel"] || l["@_rel"] === "alternate") ?? list[0];
  return alt ? absolute(orNull(text(alt["@_href"])), base) : null;
}

function parseAtom(feed: Node, feedUrl: string | null): ParsedFeed {
  const siteUrl = atomLink(feed.link, feedUrl);
  const base = siteUrl ?? feedUrl;
  const items = ((feed.entry as Node[] | undefined) ?? []).map((e): ParsedItem => {
    const authors = (e.author as Node[] | undefined) ?? [];
    const partial = {
      url: atomLink(e.link, base),
      title: text(e.title),
      author: orNull(text(authors[0]?.name)),
      content: orNull(text(e.content) || text(e.summary)),
      publishedAt: date(e.published, e.updated),
    };
    return { guid: text(e.id) || fallbackGuid(partial), ...partial };
  });
  return { title: text(feed.title), siteUrl, items };
}

function parseJsonFeed(body: string, feedUrl: string | null): ParsedFeed {
  let doc: Node;
  try {
    doc = JSON.parse(body) as Node;
  } catch (e) {
    throw new FeedParseError(`invalid JSON: ${(e as Error).message}`);
  }
  if (!text(doc.version).startsWith("https://jsonfeed.org/version/")) {
    throw new FeedParseError("not a JSON Feed");
  }
  const siteUrl = absolute(orNull(text(doc.home_page_url)), feedUrl);
  const items = ((doc.items as Node[] | undefined) ?? []).map((it): ParsedItem => {
    const authors = (it.authors as Node[] | undefined) ?? [];
    const partial = {
      url: absolute(orNull(text(it.url)), siteUrl ?? feedUrl),
      title: text(it.title),
      author: orNull(text(authors[0]?.name) || text((it.author as Node | undefined)?.name)),
      content: orNull(text(it.content_html) || text(it.content_text) || text(it.summary)),
      publishedAt: date(it.date_published, it.date_modified),
    };
    return { guid: text(it.id) || fallbackGuid(partial), ...partial };
  });
  return { title: text(doc.title), siteUrl, items };
}
