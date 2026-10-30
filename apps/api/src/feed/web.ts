import { parseHTML } from "linkedom";
import type { ParsedFeed, ParsedItem } from "./parse";

// Turns an ordinary web page into feed items, for sites without RSS.
// With a CSS selector, each matching element is an item. Without one, the page's
// article elements are used, or failing that the links in its main content.

const MAX_ITEMS = 50;
const SKIP_AREAS = "nav, header, footer, aside, form, [role=navigation], [role=banner], [role=contentinfo]";

type El = {
  tagName: string;
  textContent: string | null;
  innerHTML: string;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  querySelector(sel: string): El | null;
  querySelectorAll(sel: string): Iterable<El>;
  closest(sel: string): El | null;
};

const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

function absolute(href: string | null, base: string): string | null {
  if (!href || href.startsWith("javascript:") || href.startsWith("mailto:")) return null;
  try {
    const u = new URL(href, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

/** Short stable hash (FNV-1a, 64 bits as two halves) for items that have no link. */
export function textHash(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x5bd1e995);
  }
  return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
}

function timeOf(el: El): number | null {
  const t = el.querySelector("time[datetime]")?.getAttribute("datetime");
  const ms = t ? new Date(t).getTime() : NaN;
  return Number.isNaN(ms) ? null : ms;
}

function itemFrom(el: El, pageUrl: string): ParsedItem | null {
  for (const node of el.querySelectorAll("a[href], img[src]")) {
    const attr = node.tagName === "A" ? "href" : "src";
    const abs = absolute(node.getAttribute(attr), pageUrl);
    if (abs) node.setAttribute(attr, abs);
  }
  const text = clean(el.textContent);
  if (!text) return null;
  const link = el.tagName === "A" ? el : el.querySelector("a[href]");
  const url = link ? absolute(link.getAttribute("href"), pageUrl) : null;
  const heading = clean(el.querySelector("h1, h2, h3, h4, h5, h6")?.textContent);
  const title = heading || clean(link?.textContent) || [...text].slice(0, 80).join("");
  return {
    // Without a link the item is its text, so any change to it shows up as a new item.
    guid: url ?? `text:${textHash(text)}`,
    url: url ?? pageUrl,
    title,
    author: null,
    content: el.tagName === "A" ? null : el.innerHTML,
    publishedAt: timeOf(el),
  };
}

function autoItems(body: El, pageUrl: string): ParsedItem[] {
  const articles = [...body.querySelectorAll("article")].filter((a) => a.querySelector("a[href]") && !a.querySelector("article"));
  if (articles.length >= 2) return articles.map((a) => itemFrom(a, pageUrl)).filter((i) => i != null);

  const root = body.querySelector("main, [role=main], #content, #main") ?? body;
  const page = new URL(pageUrl);
  const items: ParsedItem[] = [];
  for (const a of root.querySelectorAll("a[href]")) {
    if (a.closest(SKIP_AREAS)) continue;
    const url = absolute(a.getAttribute("href"), pageUrl);
    const title = clean(a.textContent);
    if (!url || [...title].length < 8) continue;
    const u = new URL(url);
    // Article links stay on the site and go deeper than the page itself.
    if (u.hostname !== page.hostname || u.pathname === page.pathname || u.pathname === "/") continue;
    items.push({ guid: url, url, title, author: null, content: null, publishedAt: null });
  }
  return items;
}

export function extractWebItems(html: string, pageUrl: string, selector?: string | null): ParsedFeed {
  const { document } = parseHTML(html);
  const body = document.body as unknown as El;
  const title = clean(document.querySelector("title")?.textContent) || new URL(pageUrl).hostname;
  let items: ParsedItem[];
  if (selector) {
    let matched: El[];
    try {
      matched = [...body.querySelectorAll(selector)];
    } catch {
      throw new Error(`invalid CSS selector: ${selector}`);
    }
    items = matched.map((el) => itemFrom(el, pageUrl)).filter((i) => i != null);
  } else {
    items = autoItems(body, pageUrl);
  }
  const seen = new Set<string>();
  const unique = items.filter((i) => !seen.has(i.guid) && seen.add(i.guid));
  return { title, siteUrl: pageUrl, items: unique.slice(0, MAX_ITEMS) };
}
