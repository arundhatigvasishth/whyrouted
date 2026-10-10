import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  defineTool,
  startMcpServer,
  toCallToolResult,
  type RunningMcpServer,
  type ToolDefinition,
} from "../src/mcp/server.js";
import type { ToolResult } from "../src/mcp/types.js";

const fixedNow = () => new Date("2026-10-10T12:00:00.000Z");

const echo = defineTool(
  {
    name: "echo",
    description: "Echo the id back, grounded in the registry.",
    inputSchema: { id: z.string() },
    handler: ({ id }) => ({ kind: "data", data: { id }, source: "registry", recordIds: [id] }),
  },
  { now: fixedNow },
);
const empty = defineTool({
  name: "empty",
  description: "Always finds zero records.",
  inputSchema: {},
  handler: () => ({ kind: "data", data: { total: 0 }, source: "failover_log", recordIds: [] }),
});
const picky = defineTool({
  name: "picky",
  description: "Rejects its input.",
  inputSchema: {},
  handler: () => ({ kind: "invalid_input", reason: "from after to" }),
});
const broken = defineTool({
  name: "broken",
  description: "Throws.",
  inputSchema: {},
  handler: () => {
    throw new Error("boom");
  },
});

let running: RunningMcpServer | undefined;
let client: Client | undefined;

async function connect(tools: ToolDefinition[]): Promise<Client> {
  running = await startMcpServer({ tools, port: 0 });
  client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(running.url)));
  return client;
}

afterEach(async () => {
  await client?.close();
  await running?.close();
  client = undefined;
  running = undefined;
});

/** Pull the ToolResult back out of the single text block the server returns. */
function parse(res: Awaited<ReturnType<Client["callTool"]>>): ToolResult<unknown> {
  const content = res.content as Array<{ type: string; text: string }>;
  expect(content).toHaveLength(1);
  expect(content[0]?.type).toBe("text");
  return JSON.parse(content[0]!.text) as ToolResult<unknown>;
}

describe("toCallToolResult", () => {
  it("serializes the whole ToolResult into one text block", () => {
    const result: ToolResult<number> = {
      ok: true,
      data: 1,
      groundedIn: { source: "registry", queriedAt: "t", recordIds: ["r1"] },
    };
    const out = toCallToolResult(result);
    expect(out.content).toEqual([{ type: "text", text: JSON.stringify(result) }]);
    expect(out.isError).toBe(false);
  });

  it("treats no_data as a correct answer, not a failed call", () => {
    expect(toCallToolResult({ ok: false, code: "no_data", reason: "x" }).isError).toBe(false);
  });

  it("flags invalid_input and internal_error as errors", () => {
    expect(toCallToolResult({ ok: false, code: "invalid_input", reason: "x" }).isError).toBe(true);
    expect(toCallToolResult({ ok: false, code: "internal_error", reason: "x" }).isError).toBe(true);
  });
});

describe("MCP server", () => {
  it("lists exactly the tools it was given, with their descriptions", async () => {
    const c = await connect([echo, empty]);
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["echo", "empty"]);
    expect(tools.find((t) => t.name === "echo")?.description).toBe(
      "Echo the id back, grounded in the registry.",
    );
  });

  it("routes a call through dispatch: args in, grounding stamped by dispatch", async () => {
    const c = await connect([echo]);
    const res = await c.callTool({ name: "echo", arguments: { id: "r1" } });
    expect(res.isError).toBe(false);
    expect(parse(res)).toEqual({
      ok: true,
      data: { id: "r1" },
      groundedIn: {
        source: "registry",
        queriedAt: "2026-10-10T12:00:00.000Z",
        recordIds: ["r1"],
      },
    });
  });

  it("reports zero records as no_data, not an empty answer, and not as an error", async () => {
    const c = await connect([empty]);
    const res = await c.callTool({ name: "empty", arguments: {} });
    expect(res.isError).toBe(false);
    expect(parse(res)).toEqual({
      ok: false,
      code: "no_data",
      reason: "no records found in failover_log",
    });
  });

  it("flags invalid_input as an error result", async () => {
    const c = await connect([picky]);
    const res = await c.callTool({ name: "picky", arguments: {} });
    expect(res.isError).toBe(true);
    expect(parse(res)).toEqual({ ok: false, code: "invalid_input", reason: "from after to" });
  });

  it("turns a throwing tool into an internal_error result and stays up", async () => {
    const c = await connect([broken, echo]);
    const res = await c.callTool({ name: "broken", arguments: {} });
    expect(res.isError).toBe(true);
    expect(parse(res)).toEqual({ ok: false, code: "internal_error", reason: "boom" });
    // The server survives it.
    const next = await c.callTool({ name: "echo", arguments: { id: "r2" } });
    expect(parse(next).ok).toBe(true);
  });

  it("rejects arguments that fail the tool's input schema before the handler runs", async () => {
    const c = await connect([echo]);
    const res = await c.callTool({ name: "echo", arguments: { id: 42 } }).catch((e: unknown) => e);
    const failed = res instanceof Error || (res as { isError?: boolean }).isError === true;
    expect(failed).toBe(true);
  });

  it("answers GET and DELETE on /mcp with 405 (stateless, no sessions)", async () => {
    running = await startMcpServer({ tools: [echo], port: 0 });
    for (const method of ["GET", "DELETE"]) {
      const res = await fetch(running.url, { method });
      expect(res.status).toBe(405);
    }
  });
});
