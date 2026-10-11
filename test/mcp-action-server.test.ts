import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  defineActionTool,
  defineTool,
  startMcpServer,
  toActionCallToolResult,
  type RunningMcpServer,
  type ToolDefinition,
} from "../src/mcp/server.js";
import type { ActionResult } from "../src/mcp/action.js";
import type { ToolResult } from "../src/mcp/types.js";

const fixedNow = () => new Date("2026-10-11T12:00:00.000Z");

/** A fake setting standing in for a store, so each action has a real before and after. */
function setting(initial: string) {
  let value = initial;
  return {
    get: () => value,
    set: (v: string) => {
      value = v;
    },
  };
}

function actions() {
  const strategy = setting("least-loaded");
  const setStrategy = defineActionTool(
    {
      name: "set_strategy",
      description: "Set the strategy.",
      inputSchema: { strategy: z.string() },
      handler: ({ strategy: next }) => {
        if (next === "bogus") return { kind: "invalid_input", reason: "unknown strategy" };
        const before = { strategy: strategy.get() };
        strategy.set(next);
        return { kind: "applied", before, after: { strategy: strategy.get() } };
      },
    },
    { now: fixedNow },
  );
  const unknown = defineActionTool({
    name: "find_replica",
    description: "Fails with an unknown replica.",
    inputSchema: {},
    handler: () => ({ kind: "unknown_replica", reason: "no such replica" }),
  });
  const unsupported = defineActionTool({
    name: "unsupported_thing",
    description: "Not available here.",
    inputSchema: {},
    handler: () => ({ kind: "unsupported", reason: "no injector wired" }),
  });
  const broken = defineActionTool({
    name: "broken_action",
    description: "Throws.",
    inputSchema: {},
    handler: () => {
      throw new Error("boom");
    },
  });
  return { strategy, tools: [setStrategy, unknown, unsupported, broken] };
}

const read = defineTool(
  {
    name: "echo",
    description: "A read tool.",
    inputSchema: { id: z.string() },
    handler: ({ id }) => ({ kind: "data", data: { id }, source: "registry", recordIds: [id] }),
  },
  { now: fixedNow },
);

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

function parse<T>(res: Awaited<ReturnType<Client["callTool"]>>): T {
  const content = res.content as Array<{ type: string; text: string }>;
  expect(content).toHaveLength(1);
  return JSON.parse(content[0]!.text) as T;
}

describe("defineActionTool", () => {
  it("builds an action definition, and defineTool builds a read one", () => {
    expect(actions().tools.every((t) => t.kind === "action")).toBe(true);
    expect(read.kind).toBe("read");
  });
});

describe("toActionCallToolResult", () => {
  it("is an error for every failure and not for a success, including a no-op", () => {
    const ok = (changed: boolean | null): ActionResult<number> => ({
      ok: true,
      changed,
      after: 1,
      appliedAt: "t",
    });
    for (const changed of [true, false, null]) {
      expect(toActionCallToolResult(ok(changed)).isError).toBe(false);
    }
    for (const code of [
      "unknown_replica",
      "invalid_input",
      "unsupported",
      "internal_error",
    ] as const) {
      expect(toActionCallToolResult({ ok: false, code, reason: "x" }).isError).toBe(true);
    }
  });

  it("serializes the whole ActionResult into one text block", () => {
    const result: ActionResult<number> = { ok: true, changed: true, after: 2, appliedAt: "t" };
    expect(toActionCallToolResult(result).content).toEqual([
      { type: "text", text: JSON.stringify(result) },
    ]);
  });
});

describe("action tools over MCP", () => {
  it("lists read and action tools side by side", async () => {
    const c = await connect([read, ...actions().tools]);
    const names = (await c.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "broken_action",
      "echo",
      "find_replica",
      "set_strategy",
      "unsupported_thing",
    ]);
  });

  it("applies a change and reports before, after, changed, and appliedAt", async () => {
    const { tools, strategy } = actions();
    const c = await connect(tools);
    const raw = await c.callTool({ name: "set_strategy", arguments: { strategy: "round-robin" } });
    expect(raw.isError).toBe(false);
    expect(parse<ActionResult<{ strategy: string }>>(raw)).toEqual({
      ok: true,
      changed: true,
      before: { strategy: "least-loaded" },
      after: { strategy: "round-robin" },
      appliedAt: "2026-10-11T12:00:00.000Z",
    });
    // The result matches what the store really holds.
    expect(strategy.get()).toBe("round-robin");
  });

  it("reports a repeat call as a success with changed: false", async () => {
    const c = await connect(actions().tools);
    const raw = await c.callTool({ name: "set_strategy", arguments: { strategy: "least-loaded" } });
    expect(raw.isError).toBe(false);
    expect(parse<{ ok: true; changed: boolean }>(raw)).toMatchObject({ ok: true, changed: false });
  });

  it("flags invalid input, unknown replica, and unsupported as errors, and leaves state alone", async () => {
    const { tools, strategy } = actions();
    const c = await connect(tools);

    const bad = await c.callTool({ name: "set_strategy", arguments: { strategy: "bogus" } });
    expect(bad.isError).toBe(true);
    expect(parse(bad)).toEqual({ ok: false, code: "invalid_input", reason: "unknown strategy" });
    expect(strategy.get()).toBe("least-loaded");

    const unknown = await c.callTool({ name: "find_replica", arguments: {} });
    expect(unknown.isError).toBe(true);
    expect(parse(unknown)).toMatchObject({ code: "unknown_replica" });

    const unsupported = await c.callTool({ name: "unsupported_thing", arguments: {} });
    expect(unsupported.isError).toBe(true);
    expect(parse(unsupported)).toMatchObject({ code: "unsupported" });
  });

  it("turns a throwing action into an internal_error result and stays up", async () => {
    const c = await connect([read, ...actions().tools]);
    const raw = await c.callTool({ name: "broken_action", arguments: {} });
    expect(raw.isError).toBe(true);
    expect(parse(raw)).toEqual({ ok: false, code: "internal_error", reason: "boom" });
    const next = await c.callTool({ name: "echo", arguments: { id: "r1" } });
    expect(parse<ToolResult<unknown>>(next).ok).toBe(true);
  });

  it("still returns a read tool's result through the read mapping", async () => {
    const c = await connect([read, ...actions().tools]);
    const raw = await c.callTool({ name: "echo", arguments: { id: "r1" } });
    expect(raw.isError).toBe(false);
    expect(parse<ToolResult<unknown>>(raw)).toMatchObject({
      ok: true,
      groundedIn: { source: "registry", recordIds: ["r1"] },
    });
  });
});
