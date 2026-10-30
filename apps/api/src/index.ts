import { Hono } from "hono";
import { authenticate } from "./auth";
import type { Env } from "./env";
import { HttpError } from "./env";
import { refreshDueFeeds } from "./feed/refresh";
import { handleMcp } from "./mcp/server";
import { api } from "./routes/api";

const app = new Hono<{ Bindings: Env }>();

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
  console.error(err);
  return c.json({ error: "internal error" }, 500);
});

app.get("/health", (c) => c.json({ ok: true }));

app.route("/api", api);

app.all("/mcp", async (c) => {
  const caller = await authenticate(c.env, c.req.header("authorization"), c.executionCtx);
  return handleMcp(c.req.raw, { env: c.env, caller });
});

export default {
  fetch: app.fetch,
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(
      refreshDueFeeds(env).then((r) => console.log(`refreshed ${r.fetched} feeds: +${r.added} entries, ${r.failed} failed`)),
    );
  },
} satisfies ExportedHandler<Env>;
