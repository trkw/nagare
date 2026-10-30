import { FeedParseError, parseFeed, type ParsedFeed } from "./parse";

export const USER_AGENT = "Nagare/0.1 (+https://nagare.trkw.dev)";

const FEED_TYPES = [
  "application/rss+xml",
  "application/atom+xml",
  "application/feed+json",
  "application/json",
  "application/rdf+xml",
];
const COMMON_PATHS = ["/feed", "/rss", "/rss.xml", "/atom.xml", "/feed.xml", "/index.xml"];

export type DiscoveredFeed = { url: string; title: string };

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return m ? (m[2] ?? m[3] ?? m[4] ?? null) : null;
}

/** Finds `<link rel="alternate" type="...feed type...">` candidates in an HTML page. */
export function findFeedLinks(html: string, pageUrl: string): DiscoveredFeed[] {
  const found: DiscoveredFeed[] = [];
  const seen = new Set<string>();
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = (attr(tag, "rel") ?? "").toLowerCase().split(/\s+/);
    const type = (attr(tag, "type") ?? "").toLowerCase();
    const href = attr(tag, "href");
    if (!rel.includes("alternate") || !FEED_TYPES.includes(type) || !href) continue;
    let url: string;
    try {
      url = new URL(href, pageUrl).toString();
    } catch {
      continue;
    }
    if (seen.has(url)) continue;
    seen.add(url);
    found.push({ url, title: attr(tag, "title") ?? "" });
  }
  return found;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

async function tryFeed(fetcher: FetchLike, url: string): Promise<ParsedFeed | null> {
  try {
    const res = await fetcher(url, { headers: { "user-agent": USER_AGENT } });
    if (!res.ok) return null;
    return parseFeed(await res.text(), res.url || url);
  } catch {
    return null;
  }
}

/**
 * Returns feeds for a URL: the URL itself if it is a feed, otherwise the feeds the
 * page advertises, otherwise whichever common feed paths respond with a feed.
 */
export async function discoverFeeds(url: string, fetcher: FetchLike = fetch): Promise<DiscoveredFeed[]> {
  const res = await fetcher(url, { headers: { "user-agent": USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const finalUrl = res.url || url;
  const body = await res.text();

  try {
    const feed = parseFeed(body, finalUrl);
    return [{ url: finalUrl, title: feed.title }];
  } catch (e) {
    if (!(e instanceof FeedParseError)) throw e;
  }

  const links = findFeedLinks(body, finalUrl);
  if (links.length > 0) return links;

  const origin = new URL(finalUrl).origin;
  for (const path of COMMON_PATHS) {
    const candidate = origin + path;
    const feed = await tryFeed(fetcher, candidate);
    if (feed) return [{ url: candidate, title: feed.title }];
  }
  return [];
}
