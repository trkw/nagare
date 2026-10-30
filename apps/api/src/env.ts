export type Env = {
  DB: D1Database;
  /** Workers AI, the default translation engine. */
  AI?: Ai;
  /** Secret. When set, translation uses Claude instead of Workers AI. */
  ANTHROPIC_API_KEY?: string;
  /** Overrides the Claude model used for translation. */
  TRANSLATE_MODEL?: string;
  /** Secret. Encrypts the stored logins for password-protected feeds. */
  CREDENTIALS_KEY?: string;
  /** Web Push (VAPID). Generate with `bun run push:vapid`; the private key is a secret. */
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  /** mailto: or https: contact for push services. */
  VAPID_SUBJECT?: string;
  /** APNs: contents of the .p8 key (secret), its key id, the team id and the app's bundle id. */
  APNS_KEY?: string;
  APNS_KEY_ID?: string;
  APNS_TEAM_ID?: string;
  APNS_TOPIC?: string;
  /** FCM: the Firebase service account JSON (secret). */
  FCM_SERVICE_ACCOUNT?: string;
};

export type Scope = "read" | "write" | "subscribe" | "notify";

export type Caller = {
  id: number;
  name: string;
  kind: "app" | "agent";
  scopes: Set<Scope>;
  maxFeeds: number | null;
};

export class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 422 | 429 | 502,
    message: string,
  ) {
    super(message);
  }
}
