import { requireScope } from "../auth";
import type { Caller, Env } from "../env";
import { HttpError } from "../env";
import { apnsRequest, apnsTokenDead, type ApnsConfig } from "./apns";
import { fcmRequest, fcmTokenDead, type ServiceAccount } from "./fcm";
import { webPushRequest, type Vapid, type WebPushKeys } from "./webpush";

export type Platform = "apns" | "fcm" | "webpush";

export type PushTargetView = {
  id: number;
  platform: Platform;
  name: string;
  sandbox: number;
  last_error: string | null;
  last_sent_at: number | null;
  created_at: number;
};

export type PushMessage = {
  title: string;
  body?: string;
  url?: string | null;
  entryId?: number | null;
  /** Groups notifications from the same feed on the device. */
  threadId?: string;
  /** The agent that sent it; null for new-entry notifications. */
  source?: number | null;
};

type TargetRow = { id: number; platform: Platform; token: string; keys: string | null; sandbox: number };

const AGENT_LIMIT_PER_HOUR = 20;

function vapid(env: Env): Vapid | null {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return null;
  return { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT || "https://nagare.trkw.dev" };
}

function apns(env: Env): ApnsConfig | null {
  if (!env.APNS_KEY || !env.APNS_KEY_ID || !env.APNS_TEAM_ID) return null;
  return { key: env.APNS_KEY, keyId: env.APNS_KEY_ID, teamId: env.APNS_TEAM_ID, topic: env.APNS_TOPIC || "dev.trkw.nagare" };
}

function fcm(env: Env): ServiceAccount | null {
  if (!env.FCM_SERVICE_ACCOUNT) return null;
  try {
    return JSON.parse(env.FCM_SERVICE_ACCOUNT) as ServiceAccount;
  } catch {
    console.error("FCM_SERVICE_ACCOUNT is not valid JSON");
    return null;
  }
}

/** What the clients need to register: which services are configured, and the VAPID key for browsers. */
export function pushConfig(env: Env) {
  return { webpush_public_key: env.VAPID_PUBLIC_KEY || null, webpush: !!vapid(env), apns: !!apns(env), fcm: !!fcm(env) };
}

export async function listTargets(db: D1Database): Promise<PushTargetView[]> {
  const { results } = await db
    .prepare("SELECT id, platform, name, sandbox, last_error, last_sent_at, created_at FROM push_targets ORDER BY created_at")
    .all<PushTargetView>();
  return results;
}

function requireApp(caller: Caller): void {
  if (caller.kind !== "app") throw new HttpError(403, "registering devices needs an app token");
}

export type TargetInput = { platform?: string; token?: string; keys?: WebPushKeys; name?: string; sandbox?: boolean };

export async function registerTarget(db: D1Database, caller: Caller, input: TargetInput): Promise<PushTargetView> {
  requireApp(caller);
  const platform = input.platform as Platform;
  if (!["apns", "fcm", "webpush"].includes(platform)) throw new HttpError(400, 'platform must be "apns", "fcm" or "webpush"');
  if (!input.token) throw new HttpError(400, "token is required (the device token, or the subscription endpoint for webpush)");
  if (platform === "webpush") {
    if (!input.keys?.p256dh || !input.keys?.auth) throw new HttpError(400, "webpush needs keys.p256dh and keys.auth");
    if (!input.token.startsWith("https://")) throw new HttpError(400, "webpush token must be the https subscription endpoint");
  }
  const row = await db
    .prepare(
      `INSERT INTO push_targets (platform, token, keys, name, sandbox, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (token) DO UPDATE SET platform = excluded.platform, keys = excluded.keys, name = excluded.name,
         sandbox = excluded.sandbox, last_error = NULL
       RETURNING id, platform, name, sandbox, last_error, last_sent_at, created_at`,
    )
    .bind(
      platform,
      input.token,
      platform === "webpush" ? JSON.stringify({ p256dh: input.keys!.p256dh, auth: input.keys!.auth }) : null,
      input.name?.slice(0, 100) ?? "",
      input.sandbox ? 1 : 0,
      Date.now(),
    )
    .first<PushTargetView>();
  return row!;
}

export async function deleteTarget(db: D1Database, caller: Caller, by: { id?: number; token?: string }): Promise<void> {
  requireApp(caller);
  if (by.id != null) await db.prepare("DELETE FROM push_targets WHERE id = ?").bind(by.id).run();
  else if (by.token) await db.prepare("DELETE FROM push_targets WHERE token = ?").bind(by.token).run();
  else throw new HttpError(400, "give id or token");
}

/** Builds the request for one target, or null when its service is not configured. */
async function requestFor(env: Env, t: TargetRow, msg: PushMessage, fetcher: typeof fetch): Promise<Request | null> {
  const body = msg.body ?? "";
  const data: Record<string, unknown> = {};
  if (msg.entryId != null) data.entry_id = msg.entryId;
  if (msg.url) data.url = msg.url;
  switch (t.platform) {
    case "webpush": {
      const v = vapid(env);
      if (!v) return null;
      const payload = { title: msg.title, body, tag: msg.threadId, ...data };
      return webPushRequest(t.token, JSON.parse(t.keys!) as WebPushKeys, payload, v);
    }
    case "apns": {
      const cfg = apns(env);
      return cfg ? apnsRequest(cfg, t.token, !!t.sandbox, { title: msg.title, body, threadId: msg.threadId, data }) : null;
    }
    case "fcm": {
      const sa = fcm(env);
      return sa ? fcmRequest(sa, t.token, { title: msg.title, body, threadId: msg.threadId, data }, fetcher) : null;
    }
  }
}

async function isDead(t: TargetRow, res: Response): Promise<boolean> {
  if (t.platform === "webpush") return res.status === 404 || res.status === 410;
  if (t.platform === "apns") return apnsTokenDead(res);
  return fcmTokenDead(res);
}

/** Logs the notification and sends it to every registered device. */
export async function sendNotification(env: Env, msg: PushMessage, fetcher: typeof fetch = fetch) {
  const now = Date.now();
  await env.DB.prepare("INSERT INTO notifications (source, title, body, url, entry_id, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(msg.source ?? null, msg.title, msg.body ?? "", msg.url ?? null, msg.entryId ?? null, now)
    .run();
  const { results: targets } = await env.DB.prepare("SELECT id, platform, token, keys, sandbox FROM push_targets").all<TargetRow>();

  let sent = 0;
  let failed = 0;
  let removed = 0;
  let skipped = 0;
  await Promise.all(
    targets.map(async (t) => {
      try {
        const req = await requestFor(env, t, msg, fetcher);
        if (!req) {
          skipped++;
          return;
        }
        const res = await fetcher(req);
        if (res.ok) {
          sent++;
          await env.DB.prepare("UPDATE push_targets SET last_sent_at = ?, last_error = NULL WHERE id = ?").bind(now, t.id).run();
        } else if (await isDead(t, res)) {
          removed++;
          await env.DB.prepare("DELETE FROM push_targets WHERE id = ?").bind(t.id).run();
        } else {
          throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
        }
      } catch (e) {
        failed++;
        await env.DB.prepare("UPDATE push_targets SET last_error = ? WHERE id = ?").bind(String((e as Error).message ?? e), t.id).run();
      }
    }),
  );
  return { sent, failed, removed, skipped };
}

/** Called after entries are stored; does nothing unless the feed has notifications on. */
export async function notifyNewEntries(env: Env, feedId: number, entryIds: number[], fetcher: typeof fetch = fetch) {
  if (entryIds.length === 0) return;
  const feed = await env.DB.prepare("SELECT title, url, notify FROM feeds WHERE id = ?")
    .bind(feedId)
    .first<{ title: string; url: string; notify: number }>();
  if (!feed?.notify) return;
  const newest = await env.DB.prepare(
    `SELECT id, title, url FROM entries WHERE id IN (${entryIds.map(() => "?").join(",")})
     ORDER BY published_at DESC, id DESC LIMIT 1`,
  )
    .bind(...entryIds)
    .first<{ id: number; title: string; url: string | null }>();
  if (!newest) return;
  const more = entryIds.length - 1;
  await sendNotification(
    env,
    {
      title: feed.title || feed.url,
      body: more > 0 ? `${newest.title} ほか${more}件` : newest.title,
      entryId: newest.id,
      url: newest.url,
      threadId: `feed-${feedId}`,
    },
    fetcher,
  );
}

/** The MCP notify tool: an agent tells the owner something, limited per hour so it cannot flood the phone. */
export async function agentNotify(
  env: Env,
  caller: Caller,
  input: { title: string; body?: string; url?: string; entry_id?: number },
  fetcher: typeof fetch = fetch,
) {
  requireScope(caller, "notify");
  if (!input.title.trim()) throw new HttpError(400, "title is required");
  const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM notifications WHERE source = ? AND created_at > ?")
    .bind(caller.id, Date.now() - 3600_000)
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= AGENT_LIMIT_PER_HOUR) {
    throw new HttpError(429, `notification limit reached (${AGENT_LIMIT_PER_HOUR} per hour)`);
  }
  if (input.url) {
    try {
      new URL(input.url);
    } catch {
      throw new HttpError(400, "url must be absolute");
    }
  }
  const result = await sendNotification(
    env,
    {
      title: `${caller.name}: ${input.title.trim().slice(0, 200)}`,
      body: input.body?.slice(0, 1000),
      url: input.url,
      entryId: input.entry_id,
      threadId: `agent-${caller.id}`,
      source: caller.id,
    },
    fetcher,
  );
  return result;
}
