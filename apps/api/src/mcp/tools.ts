import { requireScope } from "../auth";
import type { Caller, Env } from "../env";
import { HttpError } from "../env";
import { discoverFeeds } from "../feed/discover";
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
      return { feeds: await discoverFeeds(need<string>(args, "url", "string")) };
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
      },
      required: ["url", "reason"],
    },
    async run({ env, caller }, args) {
      return svc.subscribe(env, caller, {
        url: need<string>(args, "url", "string"),
        reason: opt(args, "reason"),
        folder: opt(args, "folder"),
      });
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
      return svc.addItems(env.DB, caller, need<number>(args, "feed_id", "number"), items as svc.ItemInput[]);
    },
  },
  {
    name: "get_entries",
    description: "Get recent entries, newest first, with a short text preview. Use get_entry for the full text.",
    inputSchema: {
      type: "object",
      properties: {
        feed_id: int,
        folder: str,
        unread_only: { type: "boolean" },
        starred_only: { type: "boolean" },
        before: { type: "integer", description: "Only entries published before this unix ms timestamp (paging)" },
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
        limit: Math.min(Number.isInteger(args.limit) ? (args.limit as number) : 20, 100),
        withContent: true,
      });
      return { entries: entries.map(entryForAgent) };
    },
  },
  {
    name: "get_entry",
    description: "Get one entry with its full content.",
    inputSchema: { type: "object", properties: { entry_id: int }, required: ["entry_id"] },
    async run({ env, caller }, args) {
      requireScope(caller, "read");
      return svc.getEntry(env.DB, need<number>(args, "entry_id", "number"));
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
