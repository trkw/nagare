// Thin client for the Nagare REST API (apps/api).

export type Feed = {
  id: number;
  kind: "rss" | "web" | "agent";
  url: string;
  title: string;
  site_url: string | null;
  folder: string | null;
  added_by: string | null;
  reason: string | null;
  selector: string | null;
  credential: string | null;
  notify: number;
  unread: number;
  last_error: string | null;
};

export type Entry = {
  id: number;
  feed_id: number;
  feed_title: string;
  url: string | null;
  title: string;
  author: string | null;
  content?: string | null;
  published_at: number;
  read: number;
  starred: number;
};

export type Credential = { id: number; name: string; kind: "basic" | "header" | "cookie"; host: string; created_at: number };

export type CredentialInput =
  | { name: string; host: string; kind: "basic"; username: string; password: string }
  | { name: string; host: string; kind: "header"; header_name: string; header_value: string }
  | { name: string; host: string; kind: "cookie"; cookie: string };

export type FeedUpdate = {
  title?: string;
  folder?: string | null;
  selector?: string | null;
  credential?: string | null;
  notify?: boolean;
};

export type PushConfig = { webpush_public_key: string | null; webpush: boolean; apns: boolean; fcm: boolean };

export type Me = { name: string; kind: "app" | "agent"; scopes: string[] };

export type EntryQuery = {
  feed?: number;
  folder?: string;
  unread?: boolean;
  starred?: boolean;
  q?: string;
  before?: number;
  before_id?: number;
  limit?: number;
};

const TOKEN_KEY = "nagare.token";
// Used when localStorage is blocked: the token then lives only for this page load.
let memoryToken: string | null = null;

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? memoryToken;
  } catch {
    return memoryToken;
  }
}

export function setToken(token: string | null): void {
  memoryToken = token;
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage blocked: memoryToken covers this page load.
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}, token = getToken()): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token ?? ""}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(res.status, body?.error ?? `HTTP ${res.status}`);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

function qs(params: Record<string, string | number | boolean | undefined>): string {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === false || v === "") continue;
    s.set(k, v === true ? "1" : String(v));
  }
  const out = s.toString();
  return out ? `?${out}` : "";
}

export const api = {
  me: (token?: string) => request<Me>("/me", {}, token),
  feeds: () => request<Feed[]>("/feeds"),
  subscribe: (url: string, opts: { folder?: string; credential?: string } = {}) =>
    request<{ feed: Feed; created: boolean }>("/feeds", { method: "POST", body: JSON.stringify({ url, ...opts }) }),
  watchPage: (url: string, opts: { selector?: string; credential?: string } = {}) =>
    request<{ feed: Feed; created: boolean }>("/web-feeds", { method: "POST", body: JSON.stringify({ url, ...opts }) }),
  previewPage: (url: string, opts: { selector?: string; credential?: string } = {}) =>
    request<{ title: string; items: { url: string | null; title: string }[] }>("/web-feeds", {
      method: "POST",
      body: JSON.stringify({ url, ...opts, dry_run: true }),
    }),
  updateFeed: (id: number, update: FeedUpdate) =>
    request<Feed>(`/feeds/${id}`, { method: "PATCH", body: JSON.stringify(update) }),
  refreshFeed: (id: number) => request<{ added: number }>(`/feeds/${id}/refresh`, { method: "POST" }),
  credentials: () => request<Credential[]>("/credentials"),
  addCredential: (input: CredentialInput) =>
    request<Credential>("/credentials", { method: "POST", body: JSON.stringify(input) }),
  deleteCredential: (id: number) => request<void>(`/credentials/${id}`, { method: "DELETE" }),
  pushConfig: () => request<PushConfig>("/push/config"),
  registerPush: (target: { platform: "webpush"; token: string; keys: { p256dh: string; auth: string }; name: string }) =>
    request<{ id: number }>("/push/targets", { method: "POST", body: JSON.stringify(target) }),
  unregisterPush: (token: string) => request<void>("/push/targets", { method: "DELETE", body: JSON.stringify({ token }) }),
  testPush: () => request<{ sent: number; failed: number; removed: number; skipped: number }>("/push/test", { method: "POST" }),
  unsubscribe: (id: number) => request<void>(`/feeds/${id}`, { method: "DELETE" }),
  entries: (q: EntryQuery) => request<Entry[]>(`/entries${qs(q)}`),
  entry: (id: number) => request<Entry>(`/entries/${id}`),
  fullText: (id: number) => request<{ content: string }>(`/entries/${id}/fulltext`, { method: "POST" }),
  translate: (id: number, lang = "ja") =>
    request<{ title: string; content: string; engine: string; cached: boolean }>(`/entries/${id}/translate?lang=${lang}`, {
      method: "POST",
    }),
  setState: (ids: number[], state: { read?: boolean; starred?: boolean }) =>
    request<{ updated: number }>("/entries/state", { method: "POST", body: JSON.stringify({ ids, ...state }) }),
  handoff: (entryIds: number[], note: string, toAgent?: string) =>
    request<{ id: number }>("/handoffs", {
      method: "POST",
      body: JSON.stringify({ entry_ids: entryIds, note, to_agent: toAgent || undefined }),
    }),
};
