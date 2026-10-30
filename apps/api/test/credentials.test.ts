import { expect, test } from "bun:test";
import { credentialHeaders, decryptSecret, encryptSecret, normalizeHost, withCredential } from "../src/credentials";

test("secrets round-trip and need the same key", async () => {
  const stored = await encryptSecret("key-1", "hello");
  expect(stored).not.toContain("hello");
  expect(await decryptSecret("key-1", stored)).toBe("hello");
  await expect(decryptSecret("key-2", stored)).rejects.toThrow("could not be decrypted");
  await expect(encryptSecret(undefined, "x")).rejects.toThrow("CREDENTIALS_KEY");
});

test("credential headers", () => {
  expect(credentialHeaders({ kind: "basic", username: "ユーザー", password: "p" })).toEqual({
    authorization: `Basic ${Buffer.from("ユーザー:p").toString("base64")}`,
  });
  expect(credentialHeaders({ kind: "header", name: "X-Api-Key", value: "k" })).toEqual({ "x-api-key": "k" });
  expect(credentialHeaders({ kind: "cookie", value: "s=1" })).toEqual({ cookie: "s=1" });
});

test("normalizeHost accepts hosts and URLs", () => {
  expect(normalizeHost("Example.com")).toBe("example.com");
  expect(normalizeHost("https://members.example.com/feed?x=1")).toBe("members.example.com");
});

test("credentials are sent only to their host, also across redirects", async () => {
  const seen: [string, string | null][] = [];
  const routes: Record<string, Response> = {
    "https://a.example/feed": new Response(null, { status: 302, headers: { location: "/feed2" } }),
    "https://a.example/feed2": new Response(null, { status: 301, headers: { location: "https://b.example/x" } }),
    "https://b.example/x": new Response("ok"),
  };
  const fetcher = async (url: string, init?: RequestInit) => {
    seen.push([url, new Headers(init?.headers).get("authorization")]);
    return routes[url]!;
  };
  const wrapped = withCredential(fetcher, { host: "a.example", headers: { authorization: "Basic abc" } });
  const res = await wrapped("https://a.example/feed", { headers: { "user-agent": "t" } });
  expect(await res.text()).toBe("ok");
  expect(res.url).toBe("https://b.example/x");
  expect(seen).toEqual([
    ["https://a.example/feed", "Basic abc"],
    ["https://a.example/feed2", "Basic abc"],
    ["https://b.example/x", null],
  ]);
});
