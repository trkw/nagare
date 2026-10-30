import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import type { Env } from "../env";
import { HttpError } from "../env";
import { USER_AGENT, type FetchLike } from "./discover";

/** Pulls the main article out of a page, with relative links made absolute. Returns null when nothing readable is found. */
export function extractArticle(html: string, pageUrl: string): { title: string; content: string } | null {
  const { document } = parseHTML(html);
  for (const el of document.querySelectorAll("a[href], img[src]")) {
    const attr = el.tagName === "A" ? "href" : "src";
    try {
      el.setAttribute(attr, new URL(el.getAttribute(attr)!, pageUrl).toString());
    } catch {
      // Leave malformed URLs as they are.
    }
  }
  const article = new Readability(document as unknown as ConstructorParameters<typeof Readability>[0]).parse();
  if (!article?.content || (article.textContent ?? "").trim().length < 50) return null;
  return { title: article.title ?? "", content: article.content };
}

/** Fetches the entry's page, stores the extracted article as full_content and returns it. */
export async function fetchFullText(env: Env, entryId: number, fetcher: FetchLike = fetch): Promise<string> {
  const entry = await env.DB.prepare("SELECT url, full_content FROM entries WHERE id = ?")
    .bind(entryId)
    .first<{ url: string | null; full_content: string | null }>();
  if (!entry) throw new HttpError(404, `entry ${entryId} not found`);
  if (entry.full_content) return entry.full_content;
  if (!entry.url) throw new HttpError(422, "entry has no URL to fetch");

  const res = await fetcher(entry.url, { headers: { "user-agent": USER_AGENT, accept: "text/html" } }).catch((e: Error) => {
    throw new HttpError(502, `could not fetch ${entry.url}: ${e.message}`);
  });
  if (!res.ok) throw new HttpError(502, `HTTP ${res.status} from ${entry.url}`);
  const article = extractArticle(await res.text(), res.url || entry.url);
  if (!article) throw new HttpError(422, "no readable article found on the page");

  // Translations made from the shorter feed content are stale now.
  await env.DB.batch([
    env.DB.prepare("UPDATE entries SET full_content = ? WHERE id = ?").bind(article.content, entryId),
    env.DB.prepare("DELETE FROM translations WHERE entry_id = ?").bind(entryId),
  ]);
  return article.content;
}
