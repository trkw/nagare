import { requireScope } from "./auth";
import type { Caller, Env } from "./env";
import { HttpError } from "./env";
import type { FetchLike } from "./feed/discover";

// Logins for password-protected feeds and pages. Secrets are encrypted with AES-GCM under
// the CREDENTIALS_KEY secret and are never returned by the API. Each credential is bound to
// one host and only ever sent to it.

export type CredentialKind = "basic" | "header" | "cookie";
export type CredentialSecret =
  | { kind: "basic"; username: string; password: string }
  | { kind: "header"; name: string; value: string }
  | { kind: "cookie"; value: string };

export type CredentialView = { id: number; name: string; kind: CredentialKind; host: string; created_at: number };
export type Credential = { host: string; headers: Record<string, string> };

async function aesKey(secret: string | undefined): Promise<CryptoKey> {
  if (!secret) throw new HttpError(422, "CREDENTIALS_KEY is not set; run `wrangler secret put CREDENTIALS_KEY` first");
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function encryptSecret(keySecret: string | undefined, plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(keySecret), new TextEncoder().encode(plain));
  return `${b64(iv)}.${b64(new Uint8Array(data))}`;
}

export async function decryptSecret(keySecret: string | undefined, stored: string): Promise<string> {
  const [iv, data] = stored.split(".");
  const plain = await crypto.subtle
    .decrypt({ name: "AES-GCM", iv: unb64(iv!) }, await aesKey(keySecret), unb64(data!))
    .catch(() => {
      throw new HttpError(422, "a stored credential could not be decrypted; was CREDENTIALS_KEY changed?");
    });
  return new TextDecoder().decode(plain);
}

/** Accepts "example.com" or any URL on it. */
export function normalizeHost(input: string): string {
  const s = input.trim();
  try {
    return new URL(s.includes("://") ? s : `https://${s}`).hostname.toLowerCase();
  } catch {
    throw new HttpError(400, `not a host name: ${input}`);
  }
}

export function credentialHeaders(secret: CredentialSecret): Record<string, string> {
  switch (secret.kind) {
    case "basic": {
      const bytes = new TextEncoder().encode(`${secret.username}:${secret.password}`);
      return { authorization: `Basic ${b64(bytes)}` };
    }
    case "header":
      return { [secret.name.toLowerCase()]: secret.value };
    case "cookie":
      return { cookie: secret.value };
  }
}

function validateSecret(input: Record<string, unknown>): CredentialSecret {
  const s = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "");
  switch (input.kind) {
    case "basic":
      if (!s("username")) throw new HttpError(400, "username is required");
      return { kind: "basic", username: s("username"), password: s("password") };
    case "header":
      if (!/^[A-Za-z0-9-]+$/.test(s("header_name")) || !s("header_value")) {
        throw new HttpError(400, "header_name and header_value are required");
      }
      return { kind: "header", name: s("header_name"), value: s("header_value") };
    case "cookie":
      if (!s("cookie")) throw new HttpError(400, "cookie is required");
      return { kind: "cookie", value: s("cookie") };
    default:
      throw new HttpError(400, 'kind must be "basic", "header" or "cookie"');
  }
}

function requireApp(caller: Caller): void {
  if (caller.kind !== "app") throw new HttpError(403, "managing credentials needs an app token");
}

export async function listCredentials(db: D1Database): Promise<CredentialView[]> {
  const { results } = await db
    .prepare("SELECT id, name, kind, host, created_at FROM credentials ORDER BY name")
    .all<CredentialView>();
  return results;
}

export async function createCredential(env: Env, caller: Caller, input: Record<string, unknown>): Promise<CredentialView> {
  requireApp(caller);
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) throw new HttpError(400, "name is required");
  if (typeof input.host !== "string") throw new HttpError(400, "host is required");
  const host = normalizeHost(input.host);
  const secret = validateSecret(input);
  const encrypted = await encryptSecret(env.CREDENTIALS_KEY, JSON.stringify(secret));
  const row = await env.DB.prepare(
    `INSERT INTO credentials (name, kind, host, secret_encrypted, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (name) DO NOTHING RETURNING id, name, kind, host, created_at`,
  )
    .bind(name, secret.kind, host, encrypted, Date.now())
    .first<CredentialView>();
  if (!row) throw new HttpError(409, `a credential named ${name} already exists`);
  return row;
}

export async function deleteCredential(db: D1Database, caller: Caller, id: number): Promise<void> {
  requireApp(caller);
  const res = await db.prepare("DELETE FROM credentials WHERE id = ?").bind(id).run();
  if (!res.meta.changes) throw new HttpError(404, `credential ${id} not found`);
}

/** Resolves a credential name for a feed. Agents may use credentials by name; they never see the secret. */
export async function credentialIdByName(db: D1Database, caller: Caller, name: string, url: string): Promise<number> {
  requireScope(caller, "subscribe");
  const row = await db.prepare("SELECT id, host FROM credentials WHERE name = ?").bind(name).first<{ id: number; host: string }>();
  if (!row) throw new HttpError(404, `credential ${name} not found`);
  if (new URL(url).hostname.toLowerCase() !== row.host) {
    throw new HttpError(400, `credential ${name} is for ${row.host}, not ${new URL(url).hostname}`);
  }
  return row.id;
}

export async function loadCredential(env: Env, id: number | null): Promise<Credential | null> {
  if (id == null) return null;
  const row = await env.DB.prepare("SELECT host, secret_encrypted FROM credentials WHERE id = ?")
    .bind(id)
    .first<{ host: string; secret_encrypted: string }>();
  if (!row) return null;
  const secret = JSON.parse(await decryptSecret(env.CREDENTIALS_KEY, row.secret_encrypted)) as CredentialSecret;
  return { host: row.host, headers: credentialHeaders(secret) };
}

const MAX_REDIRECTS = 5;

/**
 * Wraps a fetcher so requests to the credential's host carry its headers. Redirects are
 * followed by hand, so the headers are dropped as soon as a redirect leaves that host.
 */
export function withCredential(fetcher: FetchLike, cred: Credential | null): FetchLike {
  if (!cred) return fetcher;
  return async (url, init = {}) => {
    let current = url;
    for (let hop = 0; ; hop++) {
      const headers = new Headers(init.headers);
      if (new URL(current).hostname.toLowerCase() === cred.host) {
        for (const [k, v] of Object.entries(cred.headers)) headers.set(k, v);
      }
      const res = await fetcher(current, { ...init, headers, redirect: "manual" });
      const location = res.headers.get("location");
      if (res.status < 300 || res.status >= 400 || !location) {
        // Keep the final URL so relative links resolve against it.
        return res.url ? res : Object.defineProperty(res, "url", { value: current });
      }
      if (hop >= MAX_REDIRECTS) throw new Error(`too many redirects from ${url}`);
      current = new URL(location, current).toString();
    }
  };
}
