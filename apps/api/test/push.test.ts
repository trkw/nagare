import { expect, test } from "bun:test";
import { apnsRequest, apnsTokenDead } from "../src/push/apns";
import { fcmRequest } from "../src/push/fcm";
import { b64url, concat, unb64url } from "../src/push/jwt";
import { encryptPayload, generateVapidKeys, vapidHeader } from "../src/push/webpush";

const text = (s: string) => new TextEncoder().encode(s);

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}

/** The browser side of RFC 8291, to check that what we send can be read. */
async function decrypt(body: Uint8Array, ua: CryptoKeyPair, uaPublic: Uint8Array, auth: Uint8Array) {
  const salt = body.slice(0, 16);
  const rs = new DataView(body.buffer, body.byteOffset).getUint32(16);
  const idlen = body[20]!;
  const asPublic = body.slice(21, 21 + idlen);
  const asKey = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = { name: "ECDH", public: asKey } as unknown as SubtleCryptoDeriveKeyAlgorithm;
  const shared = new Uint8Array(await crypto.subtle.deriveBits(ecdh, ua.privateKey, 256));
  const ikm = await hkdf(auth, shared, concat(text("WebPush: info\0"), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, text("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, text("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, body.slice(21 + idlen)));
  expect(rs).toBe(4096);
  expect(plain.at(-1)).toBe(2);
  return new TextDecoder().decode(plain.slice(0, -1));
}

test("web push payloads decrypt on the browser side", async () => {
  const ua = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const uaPublic = new Uint8Array((await crypto.subtle.exportKey("raw", ua.publicKey)) as ArrayBuffer);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const body = await encryptPayload({ p256dh: b64url(uaPublic), auth: b64url(auth) }, text('{"title":"新着"}'));
  expect(await decrypt(body, ua, uaPublic, auth)).toBe('{"title":"新着"}');
});

test("VAPID header carries a valid ES256 JWT for the push service origin", async () => {
  const keys = await generateVapidKeys();
  const header = await vapidHeader("https://fcm.googleapis.com/fcm/send/abc", { ...keys, subject: "mailto:me@example.com" });
  const m = header.match(/^vapid t=([^,]+), k=(.+)$/)!;
  expect(m[2]).toBe(keys.publicKey);
  const [h, c, sig] = m[1]!.split(".");
  expect(JSON.parse(new TextDecoder().decode(unb64url(c!)))).toMatchObject({ aud: "https://fcm.googleapis.com", sub: "mailto:me@example.com" });
  const pub = await crypto.subtle.importKey("raw", unb64url(keys.publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, unb64url(sig!), text(`${h}.${c}`));
  expect(ok).toBe(true);
});

async function pem(key: CryptoKey) {
  const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", key)) as ArrayBuffer);
  return `-----BEGIN PRIVATE KEY-----\n${Buffer.from(der).toString("base64")}\n-----END PRIVATE KEY-----\n`;
}

test("APNs requests use the sandbox host and topic, and dead tokens are recognized", async () => {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"])) as CryptoKeyPair;
  const req = await apnsRequest(
    { key: await pem(pair.privateKey), keyId: "KEY123", teamId: "TEAM", topic: "dev.trkw.nagare" },
    "abcd",
    true,
    { title: "T", body: "B", threadId: "feed-1", data: { entry_id: 5 } },
  );
  expect(req.url).toBe("https://api.sandbox.push.apple.com/3/device/abcd");
  expect(req.headers.get("apns-topic")).toBe("dev.trkw.nagare");
  expect(await req.json()).toEqual({ aps: { alert: { title: "T", body: "B" }, sound: "default", "thread-id": "feed-1" }, entry_id: 5 });
  const jwtHeader = JSON.parse(new TextDecoder().decode(unb64url(req.headers.get("authorization")!.split(" ")[1]!.split(".")[0]!)));
  expect(jwtHeader).toEqual({ alg: "ES256", kid: "KEY123" });
  expect(await apnsTokenDead(new Response('{"reason":"BadDeviceToken"}', { status: 400 }))).toBe(true);
  expect(await apnsTokenDead(new Response('{"reason":"TooManyRequests"}', { status: 429 }))).toBe(false);
});

test("FCM requests get an OAuth token from the service account and stringify data", async () => {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  let assertion = "";
  const fetcher = (async (_url: string, init: RequestInit) => {
    assertion = new URLSearchParams(init.body as URLSearchParams).get("assertion")!;
    return Response.json({ access_token: "ya29.x", expires_in: 3600 });
  }) as unknown as typeof fetch;
  const req = await fcmRequest(
    { client_email: "nagare@p.iam.gserviceaccount.com", private_key: await pem(pair.privateKey), project_id: "p" },
    "devtoken",
    { title: "T", body: "B", data: { entry_id: 5 } },
    fetcher,
  );
  expect(req.url).toBe("https://fcm.googleapis.com/v1/projects/p/messages:send");
  expect(req.headers.get("authorization")).toBe("Bearer ya29.x");
  expect(((await req.json()) as { message: unknown }).message).toMatchObject({ token: "devtoken", notification: { title: "T", body: "B" }, data: { entry_id: "5" } });
  const [h, c, sig] = assertion.split(".");
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", pair.publicKey, unb64url(sig!), text(`${h}.${c}`));
  expect(ok).toBe(true);
});
