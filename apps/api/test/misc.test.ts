import { expect, test } from "bun:test";
import { nextFetchDelay } from "../src/feed/refresh";
import { preview } from "../src/mcp/tools";
import { parseOpml } from "../src/opml";

test("nextFetchDelay backs off and caps at a day", () => {
  expect(nextFetchDelay(0)).toBe(30 * 60_000);
  expect(nextFetchDelay(1)).toBe(60 * 60_000);
  expect(nextFetchDelay(20)).toBe(24 * 60 * 60_000);
});

test("preview strips markup and truncates", () => {
  expect(preview("<p>Hello&nbsp;<b>world</b></p><script>x()</script>")).toBe("Hello world");
  expect(preview("あいうえお", 3)).toBe("あいう…");
  expect(preview(null)).toBe("");
});

test("parseOpml keeps folders", () => {
  const feeds = parseOpml(`<?xml version="1.0"?><opml version="2.0"><body>
    <outline text="Tech"><outline text="A" xmlUrl="https://a/rss"/><outline title="B" xmlUrl="https://b/rss"/></outline>
    <outline text="C" xmlUrl="https://c/rss"/>
  </body></opml>`);
  expect(feeds).toEqual([
    { url: "https://a/rss", title: "A", folder: "Tech" },
    { url: "https://b/rss", title: "B", folder: "Tech" },
    { url: "https://c/rss", title: "C", folder: null },
  ]);
});
