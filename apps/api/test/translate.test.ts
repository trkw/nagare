import { expect, test } from "bun:test";
import { extractArticle } from "../src/feed/fulltext";
import { looksJapanese, textBlocks, workersAiTranslator } from "../src/translate";

const PAGE = `<!doctype html><html><head><title>Site | Post</title></head><body>
  <nav><a href="/">Home</a><a href="/about">About</a></nav>
  <article>
    <h1>Why Workers</h1>
    <p>Cloudflare Workers run your code close to users. This paragraph is long enough to look like real content for the extractor to keep.</p>
    <p>See <a href="/docs">the docs</a> and <img src="img/a.png" alt="diagram"> for details about deployment and limits on the free plan.</p>
  </article>
  <footer>© 2026</footer>
</body></html>`;

test("extractArticle keeps the article, drops chrome, absolutizes links", () => {
  const a = extractArticle(PAGE, "https://blog.example/posts/1")!;
  expect(a.content).toContain("run your code close to users");
  expect(a.content).not.toContain("About");
  expect(a.content).toContain('href="https://blog.example/docs"');
  expect(a.content).toContain('src="https://blog.example/posts/img/a.png"');
});

test("extractArticle returns null for pages without content", () => {
  expect(extractArticle("<html><body><p>hi</p></body></html>", "https://x/")).toBeNull();
});

test("looksJapanese", () => {
  expect(looksJapanese("Cloudflare Workersで日本語の全文検索をする方法")).toBe(true);
  expect(looksJapanese("How to run full-text search on Workers")).toBe(false);
  expect(looksJapanese("如何在边缘运行全文搜索服务")).toBe(false);
  expect(looksJapanese("東京都議会議員選挙の結果")).toBe(true);
  expect(looksJapanese("")).toBe(false);
});

test("textBlocks translates innermost blocks and keeps structure", () => {
  const { texts, apply } = textBlocks("<h2>Title</h2><ul><li>one</li><li><p>two</p></li></ul><p>three <b>bold</b></p>");
  expect(texts).toEqual(["Title", "one", "two", "three bold"]);
  expect(apply(texts.map((t) => t.toUpperCase()))).toBe(
    "<h2>TITLE</h2><ul><li>ONE</li><li><p>TWO</p></li></ul><p>THREE BOLD</p>",
  );
});

test("textBlocks also covers text outside leaf blocks", () => {
  const { texts, apply } = textBlocks(
    "<div>Introduction</div><p>Main</p><ul><li>Parent <ul><li>child</li></ul></li></ul>bare & text<pre>code()</pre>",
  );
  expect(texts).toEqual(["Main", "child", "Introduction", "Parent", "bare & text"]);
  expect(apply(["本文", "子", "はじめに", "親", "地の文 & 文"])).toBe(
    "<div>はじめに</div><p>本文</p><ul><li>親 <ul><li>子</li></ul></li></ul>地の文 &amp; 文<pre>code()</pre>",
  );
});

test("workersAiTranslator calls m2m100 per block", async () => {
  const calls: unknown[] = [];
  const ai = {
    run: async (_model: string, input: { text: string; target_lang: string }) => {
      calls.push(input);
      return { translated_text: `[${input.target_lang}]${input.text}` };
    },
  } as unknown as Ai;
  const out = await workersAiTranslator(ai).translate({ title: "Hello", html: "<p>a</p><p>b</p>", lang: "ja" });
  expect(out).toEqual({ title: "[japanese]Hello", content: "<p>[japanese]a</p><p>[japanese]b</p>" });
  expect(calls).toHaveLength(3);
});
