import { expect, test } from "bun:test";
import { extractWebItems, textHash } from "../src/feed/web";

const page = (body: string) => `<!doctype html><html><head><title>お知らせ | Example</title></head><body>${body}</body></html>`;

test("uses article elements when the page has them", () => {
  const feed = extractWebItems(
    page(`<nav><a href="/about">About this site</a></nav>
      <article><h2>First post title</h2><a href="/posts/1">read</a><time datetime="2026-10-01T00:00:00Z"></time></article>
      <article><h2>Second post title</h2><a href="/posts/2#top">read</a></article>`),
    "https://example.com/blog",
  );
  expect(feed.title).toBe("お知らせ | Example");
  expect(feed.items.map((i) => [i.title, i.url])).toEqual([
    ["First post title", "https://example.com/posts/1"],
    ["Second post title", "https://example.com/posts/2"],
  ]);
  expect(feed.items[0]!.publishedAt).toBe(Date.parse("2026-10-01T00:00:00Z"));
  expect(feed.items[0]!.content).toContain('href="https://example.com/posts/1"');
});

test("falls back to main-content links, skipping navigation and other sites", () => {
  const feed = extractWebItems(
    page(`<header><a href="/news/menu">Header menu link</a></header>
      <main><ul>
        <li><a href="/news/2026/10/release">新しいバージョンを公開しました</a></li>
        <li><a href="/news/2026/10/release">新しいバージョンを公開しました</a></li>
        <li><a href="https://other.example/x/y">Another site entirely</a></li>
        <li><a href="/">トップページへ戻る</a></li>
        <li><a href="/news/short">短い</a></li>
      </ul></main>`),
    "https://example.com/news",
  );
  expect(feed.items.map((i) => i.url)).toEqual(["https://example.com/news/2026/10/release"]);
});

test("selector items without a link change guid when their text changes", () => {
  const a = extractWebItems(page(`<div id="status">営業中です</div>`), "https://example.com/", "#status");
  const b = extractWebItems(page(`<div id="status">本日は休業です</div>`), "https://example.com/", "#status");
  expect(a.items[0]!.guid).toBe(`text:${textHash("営業中です")}`);
  expect(a.items[0]!.url).toBe("https://example.com/");
  expect(a.items[0]!.guid).not.toBe(b.items[0]!.guid);
});

test("selector items take the heading as title and the first link as url", () => {
  const feed = extractWebItems(
    page(`<ul class="news"><li><h3>Title A</h3><a href="a.html">more</a></li><li><a href="b.html">Title B</a></li></ul>`),
    "https://example.com/list/",
    "ul.news > li",
  );
  expect(feed.items.map((i) => [i.title, i.url])).toEqual([
    ["Title A", "https://example.com/list/a.html"],
    ["Title B", "https://example.com/list/b.html"],
  ]);
});

test("an invalid selector is reported", () => {
  expect(() => extractWebItems(page("<p>x</p>"), "https://example.com/", "ul >> li")).toThrow("invalid CSS selector");
});
