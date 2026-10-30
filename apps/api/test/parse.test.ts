import { describe, expect, test } from "bun:test";
import { FeedParseError, parseFeed } from "../src/feed/parse";

describe("parseFeed", () => {
  test("RSS 2.0 with content:encoded, relative links and CDATA", () => {
    const feed = parseFeed(
      `<?xml version="1.0"?>
      <rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
        <channel>
          <title>例のブログ</title><link>https://example.com/</link>
          <item>
            <title>一本目 &amp; その他</title><link>/posts/1</link>
            <guid isPermaLink="false">post-1</guid>
            <pubDate>Wed, 29 Oct 2026 10:00:00 +0900</pubDate>
            <dc:creator>trkw</dc:creator>
            <description>短い説明</description>
            <content:encoded><![CDATA[<p>本文</p>]]></content:encoded>
          </item>
          <item><title>No guid</title><link>https://example.com/posts/2</link></item>
        </channel>
      </rss>`,
      "https://example.com/feed",
    );
    expect(feed.title).toBe("例のブログ");
    expect(feed.siteUrl).toBe("https://example.com/");
    expect(feed.items).toHaveLength(2);
    expect(feed.items[0]).toEqual({
      guid: "post-1",
      url: "https://example.com/posts/1",
      title: "一本目 & その他",
      author: "trkw",
      content: "<p>本文</p>",
      publishedAt: Date.parse("2026-10-29T01:00:00Z"),
    });
    expect(feed.items[1]!.guid).toBe("https://example.com/posts/2");
    expect(feed.items[1]!.publishedAt).toBeNull();
  });

  test("Atom with alternate links and typed title", () => {
    const feed = parseFeed(`<?xml version="1.0" encoding="utf-8"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <title>Atom Site</title>
        <link rel="self" href="https://a.example/atom.xml"/>
        <link href="https://a.example/"/>
        <entry>
          <id>tag:a.example,2026:1</id>
          <title type="html">Hello</title>
          <link rel="alternate" href="https://a.example/1"/>
          <updated>2026-10-30T00:00:00Z</updated>
          <author><name>A</name></author>
          <summary>sum</summary>
        </entry>
      </feed>`);
    expect(feed.siteUrl).toBe("https://a.example/");
    expect(feed.items[0]).toMatchObject({
      guid: "tag:a.example,2026:1",
      title: "Hello",
      url: "https://a.example/1",
      author: "A",
      content: "sum",
      publishedAt: Date.parse("2026-10-30T00:00:00Z"),
    });
  });

  test("RSS 1.0 (RDF)", () => {
    const feed = parseFeed(`<?xml version="1.0"?>
      <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
        <channel><title>RDF</title><link>https://r.example/</link></channel>
        <item><title>r1</title><link>https://r.example/1</link><dc:date>2026-10-01T00:00:00+09:00</dc:date></item>
      </rdf:RDF>`);
    expect(feed.title).toBe("RDF");
    expect(feed.items[0]).toMatchObject({ title: "r1", guid: "https://r.example/1" });
  });

  test("JSON Feed", () => {
    const feed = parseFeed(
      JSON.stringify({
        version: "https://jsonfeed.org/version/1.1",
        title: "JF",
        home_page_url: "https://j.example/",
        items: [{ id: "1", url: "/1", title: "j1", content_html: "<b>x</b>", authors: [{ name: "J" }] }],
      }),
    );
    expect(feed.items[0]).toMatchObject({ guid: "1", url: "https://j.example/1", content: "<b>x</b>", author: "J" });
  });

  test("rejects HTML", () => {
    expect(() => parseFeed("<!doctype html><html><body>hi</body></html>")).toThrow(FeedParseError);
  });
});
