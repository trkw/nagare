import { b64url, concat, signJwt, unb64url } from "./jwt";

// Web Push (RFC 8030) with VAPID (RFC 8292) and aes128gcm payload encryption (RFC 8291).

export type WebPushKeys = { p256dh: string; auth: string };
export type Vapid = { publicKey: string; privateKey: string; subject: string };

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}

const text = (s: string) => new TextEncoder().encode(s);

/** Encrypts a payload for one subscription. Returns the aes128gcm body. */
export async function encryptPayload(keys: WebPushKeys, payload: Uint8Array): Promise<Uint8Array> {
  const uaPublic = unb64url(keys.p256dh);
  const authSecret = unb64url(keys.auth);
  const local = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const asPublic = new Uint8Array((await crypto.subtle.exportKey("raw", local.publicKey)) as ArrayBuffer);
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  // workers-types spells the field $public, but the runtime (and the spec) take public.
  const ecdh = { name: "ECDH", public: uaKey } as unknown as SubtleCryptoDeriveKeyAlgorithm;
  const shared = new Uint8Array(await crypto.subtle.deriveBits(ecdh, local.privateKey, 256));

  const ikm = await hkdf(authSecret, shared, concat(text("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, text("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, text("Content-Encoding: nonce\0"), 12);

  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  // One record: the payload, then the 0x02 delimiter that marks the last record.
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, concat(payload, new Uint8Array([2]))));

  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, cipher);
}

async function vapidKey(vapid: Vapid): Promise<CryptoKey> {
  const pub = unb64url(vapid.publicKey);
  const jwk = { kty: "EC", crv: "P-256", x: b64url(pub.slice(1, 33)), y: b64url(pub.slice(33, 65)), d: vapid.privateKey };
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

export async function vapidHeader(endpoint: string, vapid: Vapid): Promise<string> {
  const jwt = await signJwt(
    { typ: "JWT", alg: "ES256" },
    { aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: vapid.subject },
    await vapidKey(vapid),
  );
  return `vapid t=${jwt}, k=${vapid.publicKey}`;
}

// One aes128gcm record of 4096 bytes holds the payload plus the 16-byte tag and the delimiter byte.
// Push services also cap the whole body at 4096 bytes, which includes the 86-byte header.
export const MAX_PAYLOAD_BYTES = 4096 - 86 - 16 - 1;

export type WebPushPayload = { title: string; body: string; url?: string; [key: string]: unknown };

/** Serializes the payload, shortening the body (then dropping the url) until it fits in one record. */
export function fitPayload(payload: WebPushPayload): Uint8Array {
  let p = { ...payload };
  let bytes = text(JSON.stringify(p));
  if (bytes.length > MAX_PAYLOAD_BYTES && p.url && text(p.url).length > 1000) {
    const { url: _drop, ...rest } = p;
    p = rest;
    bytes = text(JSON.stringify(p));
  }
  let chars = [...p.body];
  while (bytes.length > MAX_PAYLOAD_BYTES && chars.length > 0) {
    const over = bytes.length - MAX_PAYLOAD_BYTES;
    // A character is at most 4 bytes in UTF-8 (and 6 when JSON-escaped), so this always makes progress.
    chars = chars.slice(0, Math.max(0, chars.length - Math.ceil(over / 6) - 1));
    p = { ...p, body: `${chars.join("")}…` };
    bytes = text(JSON.stringify(p));
  }
  if (bytes.length > MAX_PAYLOAD_BYTES) {
    p = { ...p, title: [...p.title].slice(0, 100).join(""), body: "" };
    bytes = text(JSON.stringify(p));
  }
  return bytes;
}

export async function webPushRequest(endpoint: string, keys: WebPushKeys, payload: WebPushPayload, vapid: Vapid): Promise<Request> {
  const body = await encryptPayload(keys, fitPayload(payload));
  return new Request(endpoint, {
    method: "POST",
    headers: {
      authorization: await vapidHeader(endpoint, vapid),
      "content-encoding": "aes128gcm",
      "content-type": "application/octet-stream",
      ttl: "86400",
      urgency: "normal",
    },
    body,
  });
}

/** New VAPID key pair: the public key as an uncompressed point and the private scalar, both base64url. */
export async function generateVapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  return { publicKey: b64url(raw), privateKey: jwk.d! };
}
