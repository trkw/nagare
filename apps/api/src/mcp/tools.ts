import { requireScope } from "../auth";
import type { Caller, Env } from "../env";
import { listCredentials } from "../credentials";
import { HttpError } from "../env";
import { agentNotify } from "../push";
import { discoverFeeds } from "../feed/discover";
import { fetchFullText } from "../feed/fulltext";
import { translateEntry } from "../translate";
import * as svc from "../service";

export type ToolContext = { env: Env; caller: Caller };

type Tool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (ctx: ToolContext, args: Record<string, unknown>) => Promise<unknown>;
};

const str = { type: "string" } as const;
const int = { type: "integer" } as const;

function need<T>(args: Record<string, unknown>, key: string, type: "string" | "number" | "object"): T {
  const v = args[key];
  if (type === "number" ? !Number.isInteger(v) : typeof v !== type || v === null) {
    throw new HttpError(400, `"${key}" must be ${type === "number" ? "an integer" : `a ${type}`}`);
  }
  return v as T;
}

const opt = (args: Record<string, unknown>, key: string) =>
  typeof args[key] === "string" && args[key] !== "" ? (args[key] as string) : undefined;

/** Plain-text preview so agents get the gist without spending tokens on markup. */
export function preview(html: string | null | undefined, max = 400): string {
  if (!html) return "";
  const plain = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return [...plain].length > max ? `${[...plain].slice(0, max).join("")}…` : plain;
}

const entryForAgent = (e: svc.EntryView) => ({
  id: e.id,
  feed: e.feed_title,
  title: e.title,
  url: e.url,
  author: e.author,
  published_at: new Date(e.published_at).toISOString(),
  published_at_ms: e.published_at,
  read: !!e.read,
  starred: !!e.starred,
  preview: preview(e.content),
});

export const tools: Tool[] = [
  {
    name: "discover_feed",
    description: "Find the RSS/Atom/JSON feeds offered by a web page or site URL, without subscribing.",
    inputSchema: { type: "object", properties: { url: str }, required: ["url"] },
    async run({ caller }, args) {
      requireScope(caller, "read");
      const feeds = await discoverFeeds(need<string>(args, "url", "string"));
      return feeds.length ? { feeds } : { feeds, hint: "No feed found. create_web_feed can watch the page itself." };
    },
  },
  {
    name: "subscribe_feed",
    description:
      "Subscribe Nagare to a feed. Accepts a feed URL or a page URL (the feed is discovered). " +
      "Always give a short reason so the owner knows why it was added.",
    inputSchema: {
      type: "object",
      properties: {
        url: str,
        reason: { type: "string", description: "Why this feed is worth reading, shown to the owner" },
        folder: { type: "string", description: "Folder name; created if missing" },
        credential: { type: "string", description: "Name of a saved login (see list_credentials) for a protected feed" },
      },
      required: ["url", "reason"],
    },
    async run({ env, caller }, args) {
      return svc.subscribe(env, caller, {
        url: need<string>(args, "url", "string"),
        reason: opt(args, "reason"),
        folder: opt(args, "folder"),
        credential: opt(args, "credential"),
      });
    },
  },
  {
    name: "create_web_feed",
    description:
      "Watch a web page that has no feed. Without a selector, the page's articles or main-content links become entries. " +
      "With a CSS selector, each matching element is an entry; an element without a link becomes a new entry whenever " +
      "its text changes. Try dry_run first to see what would be picked up.",
    inputSchema: {
      type: "object",
      properties: {
        url: str,
        selector: { type: "string", description: "CSS selector for the items, e.g. \"ul.news > li\"" },
        title: str,
        reason: { type: "string", description: "Why this page is worth watching, shown to the owner" },
        folder: str,
        credential: { type: "string", description: "Name of a saved login for a members-only page" },
        dry_run: { type: "boolean", description: "Only return the items that would be found" },
      },
      required: ["url", "reason"],
    },
    async run({ env, caller }, args) {
      return svc.createWebFeed(env, caller, {
        url: need<string>(args, "url", "string"),
        selector: opt(args, "selector"),
        title: opt(args, "title"),
        reason: opt(args, "reason"),
        folder: opt(args, "folder"),
        credential: opt(args, "credential"),
        dry_run: args.dry_run === true,
      });
    },
  },
  {
    name: "list_credentials",
    description:
      "List the saved logins (name, kind, host) you can pass as credential when subscribing to a protected feed or page. " +
      "Secrets are never shown, and each login is only sent to its host. The owner adds them in the app.",
    inputSchema: { type: "object", properties: {} },
    async run({ env, caller }) {
      requireScope(caller, "read");
      return { credentials: await listCredentials(env.DB) };
    },
  },
  {
    name: "unsubscribe_feed",
    description: "Remove a feed. Agents can only remove feeds they added themselves.",
    inputSchema: { type: "object", properties: { feed_id: int }, required: ["feed_id"] },
    async run({ env, caller }, args) {
      await svc.unsubscribe(env.DB, caller, need<number>(args, "feed_id", "number"));
      return { ok: true };
    },
  },
  {
    name: "list_feeds",
    description: "List subscribed feeds with folder, who added them, and unread counts.",
    inputSchema: { type: "object", properties: {} },
    async run({ env, caller }) {
      requireScope(caller, "read");
      return { feeds: await svc.listFeeds(env.DB) };
    },
  },
  {
    name: "create_agent_feed",
    description:
      "Create a feed that you fill yourself with add_items, for sources without RSS such as an X (Twitter) " +
      "account or an Instagram profile. Use the source's profile URL as url. Returns the existing feed if it exists.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Source URL, e.g. https://x.com/someone" },
        title: str,
        reason: str,
        folder: str,
      },
      required: ["url", "title", "reason"],
    },
    async run({ env, caller }, args) {
      return svc.createAgentFeed(env.DB, caller, {
        url: need<string>(args, "url", "string"),
        title: need<string>(args, "title", "string"),
        reason: opt(args, "reason"),
        folder: opt(args, "folder"),
      });
    },
  },
  {
    name: "add_items",
    description:
      "Write posts into an agent feed you created. Items with a guid or url already stored are skipped, " +
      "so it is safe to send the same posts again.",
    inputSchema: {
      type: "object",
      properties: {
        feed_id: int,
        items: {
          type: "array",
          maxItems: 100,
          items: {
            type: "object",
            properties: {
              guid: str,
              url: str,
              title: str,
              content: { type: "string", description: "HTML or plain text" },
              author: str,
              published_at: { type: "string", description: "ISO 8601" },
            },
            required: ["title"],
          },
        },
      },
      required: ["feed_id", "items"],
    },
    async run({ env, caller }, args) {
      const items = args.items;
      if (!Array.isArray(items)) throw new HttpError(400, '"items" must be an array');
      return svc.addItems(env, caller, need<number>(args, "feed_id", "number"), items as svc.ItemInput[]);
    },
  },
  {
    name: "get_entries",
    description:
      "Get recent entries, newest first, with a short text preview. Use get_entry for the full text. " +
      "For the next page pass the last entry's published_at_ms as before and its id as before_id.",
    inputSchema: {
      type: "object",
      properties: {
        feed_id: int,
        folder: str,
        unread_only: { type: "boolean" },
        starred_only: { type: "boolean" },
        before: { type: "integer", description: "Paging: published_at of the last entry you got (unix ms)" },
        before_id: { type: "integer", description: "Paging: id of the last entry you got" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
    },
    async run({ env, caller }, args) {
      requireScope(caller, "read");
      const entries = await svc.listEntries(env.DB, {
        feed: Number.isInteger(args.feed_id) ? (args.feed_id as number) : undefined,
        folder: opt(args, "folder"),
        unread: args.unread_only === true,
        starred: args.starred_only === true,
        before: Number.isInteger(args.before) ? (args.before as number) : undefined,
        beforeId: Number.isInteger(args.before_id) ? (args.before_id as number) : undefined,
        limit: Math.min(Number.isInteger(args.limit) ? (args.limit as number) : 20, 100),
        withContent: true,
      });
      return { entries: entries.map(entryForAgent) };
    },
  },
  {
    name: "get_entry",
    description:
      "Get one entry with its content. Set full_text to fetch the whole article from its page when the feed " +
      "only carries a summary (stored for later reads).",
    inputSchema: {
      type: "object",
      properties: { entry_id: int, full_text: { type: "boolean" } },
      required: ["entry_id"],
    },
    async run({ env, caller }, args) {
      requireScope(caller, "read");
      const id = need<number>(args, "entry_id", "number");
      let fullTextError: string | undefined;
      if (args.full_text === true) {
        requireScope(caller, "write");
        // On failure fall back to the feed content and say why.
        await fetchFullText(env, id).catch((e: Error) => {
          if (!(e instanceof HttpError)) throw e;
          fullTextError = e.message;
        });
      }
      const entry = await svc.getEntry(env.DB, id);
      return fullTextError ? { ...entry, full_text_error: fullTextError } : entry;
    },
  },
  {
    name: "translate_entry",
    description: "Translate an entry (title and content) into a language, Japanese by default. Results are cached.",
    inputSchema: {
      type: "object",
      properties: { entry_id: int, lang: { type: "string", description: "Two-letter code, default ja" } },
      required: ["entry_id"],
    },
    async run({ env, caller }, args) {
      requireScope(caller, "read");
      const lang = opt(args, "lang") ?? "ja";
      if (!/^[a-z]{2}$/.test(lang)) throw new HttpError(400, '"lang" must be a two-letter code');
      return translateEntry(env, need<number>(args, "entry_id", "number"), lang);
    },
  },
  {
    name: "search_entries",
    description: "Full-text search over entry titles and content (works for Japanese).",
    inputSchema: {
      type: "object",
      properties: { query: str, limit: { type: "integer", minimum: 1, maximum: 100 } },
      required: ["query"],
    },
    async run({ env, caller }, args) {
      requireScope(caller, "read");
      const entries = await svc.listEntries(env.DB, {
        q: need<string>(args, "query", "string"),
        limit: Math.min(Number.isInteger(args.limit) ? (args.limit as number) : 20, 100),
        withContent: true,
      });
      return { entries: entries.map(entryForAgent) };
    },
  },
  {
    name: "mark_read",
    description: "Mark entries read or unread.",
    inputSchema: {
      type: "object",
      properties: { entry_ids: { type: "array", items: int }, read: { type: "boolean", default: true } },
      required: ["entry_ids"],
    },
    async run({ env, caller }, args) {
      return svc.setEntryState(env.DB, caller, ids(args), { read: args.read !== false });
    },
  },
  {
    name: "star_entry",
    description: "Star (save for later) or unstar entries.",
    inputSchema: {
      type: "object",
      properties: { entry_ids: { type: "array", items: int }, starred: { type: "boolean", default: true } },
      required: ["entry_ids"],
    },
    async run({ env, caller }, args) {
      return svc.setEntryState(env.DB, caller, ids(args), { starred: args.starred !== false });
    },
  },
  {
    name: "notify",
    description:
      "Send a push notification to the owner's phone and computers, e.g. when you find something they should " +
      "read now. Use sparingly: at most 20 per hour. Link an entry with entry_id or any page with url.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short headline; your name is prefixed automatically" },
        body: str,
        url: str,
        entry_id: int,
      },
      required: ["title"],
    },
    async run({ env, caller }, args) {
      return agentNotify(env, caller, {
        title: need<string>(args, "title", "string"),
        body: opt(args, "body"),
        url: opt(args, "url"),
        entry_id: Number.isInteger(args.entry_id) ? (args.entry_id as number) : undefined,
      });
    },
  },
  {
    name: "get_handoffs",
    description:
      "Receive what the owner sent you with \"Send to agent\": entries plus their note. " +
      "Each handoff is returned once and then marked as picked up.",
    inputSchema: { type: "object", properties: {} },
    async run({ env, caller }) {
      return { handoffs: await svc.takeHandoffs(env.DB, caller) };
    },
  },
];

function ids(args: Record<string, unknown>): number[] {
  const v = args.entry_ids;
  if (!Array.isArray(v) || !v.every(Number.isInteger)) throw new HttpError(400, '"entry_ids" must be an array of integers');
  return v as number[];
}
