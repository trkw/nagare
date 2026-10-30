export type Env = {
  DB: D1Database;
  /** Workers AI, the default translation engine. */
  AI?: Ai;
  /** Secret. When set, translation uses Claude instead of Workers AI. */
  ANTHROPIC_API_KEY?: string;
  /** Overrides the Claude model used for translation. */
  TRANSLATE_MODEL?: string;
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
    readonly status: 400 | 401 | 403 | 404 | 409 | 422 | 502,
    message: string,
  ) {
    super(message);
  }
}
