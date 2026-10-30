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

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Private mode: the token lives only for this page load.
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
  subscribe: (url: string, folder?: string) =>
    request<{ feed: Feed; created: boolean }>("/feeds", { method: "POST", body: JSON.stringify({ url, folder }) }),
  unsubscribe: (id: number) => request<void>(`/feeds/${id}`, { method: "DELETE" }),
  entries: (q: EntryQuery) => request<Entry[]>(`/entries${qs(q)}`),
  entry: (id: number) => request<Entry>(`/entries/${id}`),
  setState: (ids: number[], state: { read?: boolean; starred?: boolean }) =>
    request<{ updated: number }>("/entries/state", { method: "POST", body: JSON.stringify({ ids, ...state }) }),
  handoff: (entryIds: number[], note: string, toAgent?: string) =>
    request<{ id: number }>("/handoffs", {
      method: "POST",
      body: JSON.stringify({ entry_ids: entryIds, note, to_agent: toAgent || undefined }),
    }),
};
