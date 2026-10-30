import { HttpError } from "../env";
import { tools, type ToolContext } from "./tools";

// A minimal stateless MCP server over Streamable HTTP: every POST carries JSON-RPC
// and gets a JSON response, so no sessions or SSE are needed on Workers.

export const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "nagare", title: "Nagare RSS", version: "0.1.0" };
const INSTRUCTIONS =
  "Nagare is the owner's RSS reader. You can find and subscribe to feeds, create feeds for sources " +
  "without RSS (X, Instagram) and fill them with add_items, read entries, and pick up what the owner sent you.";

type JsonRpcRequest = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: Record<string, unknown> };
type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: string | number | null; result: unknown }
  | { jsonrpc: "2.0"; id: string | number | null; error: { code: number; message: string } };

const rpcError = (id: JsonRpcRequest["id"], code: number, message: string): JsonRpcResponse => ({
  jsonrpc: "2.0",
  id: id ?? null,
  error: { code, message },
});

async function callTool(ctx: ToolContext, params: Record<string, unknown> | undefined) {
  const tool = tools.find((t) => t.name === params?.name);
  if (!tool) return null;
  try {
    const result = await tool.run(ctx, (params?.arguments as Record<string, unknown> | undefined) ?? {});
    return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(`tool ${tool.name} failed`, e);
    return { content: [{ type: "text", text: (e as Error).message }], isError: true };
  }
}

async function dispatch(ctx: ToolContext, msg: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  const isNotification = msg.id === undefined;
  switch (msg.method) {
    case "initialize": {
      const requested = String(msg.params?.protocolVersion ?? "");
      return {
        jsonrpc: "2.0",
        id: msg.id ?? null,
        result: {
          protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        },
      };
    }
    case "ping":
      return { jsonrpc: "2.0", id: msg.id ?? null, result: {} };
    case "tools/list":
      return {
        jsonrpc: "2.0",
        id: msg.id ?? null,
        result: { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) },
      };
    case "tools/call": {
      const result = await callTool(ctx, msg.params);
      if (!result) return rpcError(msg.id, -32602, `unknown tool: ${String(msg.params?.name)}`);
      return { jsonrpc: "2.0", id: msg.id ?? null, result };
    }
    default:
      if (isNotification) return null; // notifications/initialized, notifications/cancelled, ...
      return rpcError(msg.id, -32601, `method not found: ${msg.method}`);
  }
}

export async function handleMcp(request: Request, ctx: ToolContext): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Nagare MCP accepts POST only (stateless, no SSE stream).", {
      status: 405,
      headers: { allow: "POST" },
    });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(rpcError(null, -32700, "parse error"), { status: 400 });
  }

  const messages = (Array.isArray(body) ? body : [body]) as JsonRpcRequest[];
  const responses: JsonRpcResponse[] = [];
  for (const msg of messages) {
    if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
      responses.push(rpcError((msg as JsonRpcRequest | undefined)?.id, -32600, "invalid request"));
      continue;
    }
    const res = await dispatch(ctx, msg);
    if (res) responses.push(res);
  }

  if (responses.length === 0) return new Response(null, { status: 202 });
  return Response.json(Array.isArray(body) ? responses : responses[0]);
}
