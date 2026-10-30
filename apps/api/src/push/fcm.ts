import { pemToDer, signJwt } from "./jwt";

// Firebase Cloud Messaging HTTP v1 with a service account.

export type ServiceAccount = { client_email: string; private_key: string; project_id: string };

let cached: { token: string; expires: number; email: string } | null = null;

async function accessToken(sa: ServiceAccount, fetcher: typeof fetch): Promise<string> {
  if (cached && cached.email === sa.client_email && Date.now() < cached.expires) return cached.token;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const now = Math.floor(Date.now() / 1000);
  const assertion = await signJwt(
    { alg: "RS256", typ: "JWT" },
    {
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    },
    key,
  );
  const res = await fetcher("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  if (!res.ok) throw new Error(`FCM auth failed: HTTP ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { access_token: string; expires_in: number };
  cached = { token: body.access_token, expires: Date.now() + (body.expires_in - 300) * 1000, email: sa.client_email };
  return body.access_token;
}

export async function fcmRequest(
  sa: ServiceAccount,
  deviceToken: string,
  msg: { title: string; body: string; threadId?: string; data: Record<string, unknown> },
  fetcher: typeof fetch = fetch,
): Promise<Request> {
  // FCM data values must be strings.
  const data = Object.fromEntries(Object.entries(msg.data).map(([k, v]) => [k, String(v)]));
  return new Request(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
    method: "POST",
    headers: { authorization: `Bearer ${await accessToken(sa, fetcher)}`, "content-type": "application/json" },
    body: JSON.stringify({
      message: {
        token: deviceToken,
        notification: { title: msg.title, body: msg.body },
        data,
        android: { priority: "high", notification: msg.threadId ? { tag: msg.threadId } : undefined },
      },
    }),
  });
}

export async function fcmTokenDead(res: Response): Promise<boolean> {
  if (res.status === 404) return true;
  if (res.status !== 400) return false;
  const body = await res.clone().text();
  return body.includes("UNREGISTERED") || body.includes("registration token is not a valid");
}
