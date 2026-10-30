// Creates an API token and stores its hash in D1.
//   bun run token:create --name grokbot --kind agent [--max-feeds 50] [--remote]
//   bun run token:create --name iphone --kind app --remote
import { parseArgs } from "node:util";
import { sha256Hex } from "../src/auth";

const { values } = parseArgs({
  options: {
    name: { type: "string" },
    kind: { type: "string", default: "agent" },
    scopes: { type: "string" },
    "max-feeds": { type: "string" },
    remote: { type: "boolean", default: false },
  },
});

if (!values.name || !["app", "agent"].includes(values.kind!)) {
  console.error("usage: bun run token:create --name <name> --kind app|agent [--scopes 'read write subscribe notify'] [--max-feeds N] [--remote]");
  process.exit(1);
}

const bytes = crypto.getRandomValues(new Uint8Array(32));
const token = `ngr_${Buffer.from(bytes).toString("base64url")}`;
const scopes = values.scopes ?? "read write subscribe notify";
const maxFeeds = values["max-feeds"] ? Number(values["max-feeds"]) : values.kind === "agent" ? 100 : null;
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const sql =
  `INSERT INTO tokens (name, kind, scopes, hash, max_feeds, created_at) VALUES ` +
  `(${q(values.name!)}, ${q(values.kind!)}, ${q(scopes)}, ${q(await sha256Hex(token))}, ${maxFeeds ?? "NULL"}, ${Date.now()})`;

const proc = Bun.spawnSync(
  ["bunx", "wrangler", "d1", "execute", "nagare", values.remote ? "--remote" : "--local", "--command", sql],
  { stdout: "inherit", stderr: "inherit" },
);
if (proc.exitCode !== 0) process.exit(proc.exitCode ?? 1);

console.log(`\nToken for ${values.name} (${values.kind}, shown once):\n${token}`);
