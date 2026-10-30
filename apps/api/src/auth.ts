import type { Caller, Env, Scope } from "./env";
import { HttpError } from "./env";

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

type TokenRow = { id: number; name: string; kind: "app" | "agent"; scopes: string; max_feeds: number | null };

export async function authenticate(env: Env, header: string | undefined, ctx?: { waitUntil(p: Promise<unknown>): void }): Promise<Caller> {
  const token = header?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!token) throw new HttpError(401, "missing bearer token");
  const row = await env.DB.prepare("SELECT id, name, kind, scopes, max_feeds FROM tokens WHERE hash = ?")
    .bind(await sha256Hex(token))
    .first<TokenRow>();
  if (!row) throw new HttpError(401, "invalid token");
  const touch = env.DB.prepare("UPDATE tokens SET last_used_at = ? WHERE id = ?").bind(Date.now(), row.id).run();
  ctx ? ctx.waitUntil(touch) : await touch;
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    scopes: new Set(row.scopes.split(/\s+/).filter(Boolean) as Scope[]),
    maxFeeds: row.max_feeds,
  };
}

export function requireScope(caller: Caller, scope: Scope): void {
  if (!caller.scopes.has(scope)) throw new HttpError(403, `token lacks the "${scope}" scope`);
}
