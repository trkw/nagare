import { pemToDer, signJwt } from "./jwt";

// Apple Push Notification service, token-based auth with the .p8 key.

export type ApnsConfig = { key: string; keyId: string; teamId: string; topic: string };

let cached: { jwt: string; at: number; keyId: string } | null = null;

async function providerToken(cfg: ApnsConfig): Promise<string> {
  // Apple wants the token reused for up to an hour and refreshed at least every 60 minutes.
  if (cached && cached.keyId === cfg.keyId && Date.now() - cached.at < 50 * 60_000) return cached.jwt;
  const key = await crypto.subtle.importKey("pkcs8", pemToDer(cfg.key), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const jwt = await signJwt({ alg: "ES256", kid: cfg.keyId }, { iss: cfg.teamId, iat: Math.floor(Date.now() / 1000) }, key);
  cached = { jwt, at: Date.now(), keyId: cfg.keyId };
  return jwt;
}

export async function apnsRequest(
  cfg: ApnsConfig,
  deviceToken: string,
  sandbox: boolean,
  msg: { title: string; body: string; threadId?: string; data: Record<string, unknown> },
): Promise<Request> {
  const host = sandbox ? "api.sandbox.push.apple.com" : "api.push.apple.com";
  return new Request(`https://${host}/3/device/${deviceToken}`, {
    method: "POST",
    headers: {
      authorization: `bearer ${await providerToken(cfg)}`,
      "apns-topic": cfg.topic,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      aps: { alert: { title: msg.title, body: msg.body }, sound: "default", ...(msg.threadId ? { "thread-id": msg.threadId } : {}) },
      ...msg.data,
    }),
  });
}

/** True when Apple says the token will never work again, so the target should be dropped. */
export async function apnsTokenDead(res: Response): Promise<boolean> {
  if (res.status === 410) return true;
  if (res.status !== 400) return false;
  const reason = ((await res.clone().json().catch(() => ({}))) as { reason?: string }).reason;
  return reason === "BadDeviceToken" || reason === "DeviceTokenNotForTopic";
}
