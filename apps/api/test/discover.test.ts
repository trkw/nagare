import { expect, test } from "bun:test";
import { discoverFeeds, findFeedLinks } from "../src/feed/discover";

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>Found</title></channel></rss>`;

function fakeFetch(pages: Record<string, string>) {
  return async (url: string) => {
    const body = pages[url];
    return body == null ? new Response("nope", { status: 404 }) : new Response(body);
  };
}

test("findFeedLinks reads alternate links in any attribute order", () => {
  const html = `<head>
    <link href="/feed.xml" type="application/rss+xml" rel="alternate" title="Main">
    <link rel='alternate' type='application/atom+xml' href='https://cdn.example/atom'>
    <link rel="stylesheet" href="/x.css">
    <link rel="alternate" hreflang="en" href="/en">
  </head>`;
  expect(findFeedLinks(html, "https://example.com/blog/")).toEqual([
    { url: "https://example.com/feed.xml", title: "Main" },
    { url: "https://cdn.example/atom", title: "" },
  ]);
});

test("a feed URL is returned as is", async () => {
  const feeds = await discoverFeeds("https://e.com/rss", fakeFetch({ "https://e.com/rss": RSS }));
  expect(feeds).toEqual([{ url: "https://e.com/rss", title: "Found" }]);
});

test("a page's advertised feed is found", async () => {
  const page = `<html><head><link rel="alternate" type="application/rss+xml" href="/rss.xml"></head></html>`;
  const feeds = await discoverFeeds("https://e.com/", fakeFetch({ "https://e.com/": page }));
  expect(feeds).toEqual([{ url: "https://e.com/rss.xml", title: "" }]);
});

test("falls back to common feed paths", async () => {
  const feeds = await discoverFeeds(
    "https://e.com/about",
    fakeFetch({ "https://e.com/about": "<html></html>", "https://e.com/index.xml": RSS }),
  );
  expect(feeds).toEqual([{ url: "https://e.com/index.xml", title: "Found" }]);
});

test("returns nothing when no feed exists", async () => {
  expect(await discoverFeeds("https://e.com/", fakeFetch({ "https://e.com/": "<html></html>" }))).toEqual([]);
});
