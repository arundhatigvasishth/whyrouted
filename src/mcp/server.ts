/**
 * MCP server scaffold (O5, M5a).
 *
 * Serves the read tools over MCP's Streamable HTTP transport, in the same
 * process as the API server (docs/decisions.md, 2026-09-29: the server is
 * in-process, so it cannot use stdio, `main.ts` already owns stdout). Shape
 * fixed by docs/milestones/m5a/shared-contract.md, O1 and O2.
 *
 * Every tool is built with `defineTool`, which wraps its handler in
 * `dispatch` (./types.ts). The server only accepts what `defineTool` returns,
 * so a tool cannot reach the protocol without going through the grounding
 * envelope. Turning a `ToolResult` into an MCP `CallToolResult` happens here,
 * at the protocol edge, and nowhere else.
 *
 * Stateless: each `POST /mcp` builds a fresh `McpServer` and transport. The
 * tools read shared state through the store instances their factories closed
 * over, so there is no per-session state to keep and nothing to clean up
 * between calls.
 */

import express, { type Express } from "express";
import type { Server } from "node:http";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createAuthMiddleware } from "./auth.js";
import { dispatch, type DispatchOptions, type ToolHandler, type ToolResult } from "./types.js";

/** A tool ready to register. Only `defineTool` builds one, so every tool goes through `dispatch`. */
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodRawShape;
  /** The handler wrapped in `dispatch`: always resolves to a `ToolResult`. */
  readonly call: (args: unknown) => Promise<ToolResult<unknown>>;
}

export interface ToolSpec<S extends z.ZodRawShape, T> {
  name: string;
  description: string;
  /** Zod shape for the tool's arguments. `{}` for a tool that takes none. */
  inputSchema: S;
  handler: ToolHandler<z.infer<z.ZodObject<S>>, T>;
}

/** Wrap a tool's handler in `dispatch` and return the registrable form. */
export function defineTool<S extends z.ZodRawShape, T>(
  spec: ToolSpec<S, T>,
  opts?: DispatchOptions,
): ToolDefinition {
  const call = dispatch(spec.handler, opts);
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: spec.inputSchema,
    call: (args) => call(args as z.infer<z.ZodObject<S>>),
  };
}

/**
 * Map a `ToolResult` onto the protocol's result: one text block holding the
 * whole `ToolResult` as JSON. `no_data` is a correct, grounded answer and not
 * a failed call, so only `invalid_input` and `internal_error` set `isError`.
 */
export function toCallToolResult(result: ToolResult<unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    isError: !result.ok && result.code !== "no_data",
  };
}

/** Build an `McpServer` with every tool registered. */
export function createMcpServer(tools: readonly ToolDefinition[]): McpServer {
  const server = new McpServer({ name: "whyrouted", version: "0.1.0" });
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      async (args: unknown) => toCallToolResult(await tool.call(args)),
    );
  }
  return server;
}

const METHOD_NOT_ALLOWED = {
  jsonrpc: "2.0",
  error: { code: -32000, message: "Method not allowed." },
  id: null,
};

/**
 * Build the Express app serving `POST /mcp`. Exposed separately from
 * {@link startMcpServer} so tests can drive it without a fixed port.
 */
export function createMcpApp(
  tools: readonly ToolDefinition[],
  opts: { token?: string } = {},
): Express {
  const app = express();
  // First, so it runs before body parsing and before any route, 405s included.
  if (opts.token !== undefined) app.use(createAuthMiddleware(opts.token));
  app.use(express.json());

  app.post("/mcp", async (req, res) => {
    const server = createMcpServer(tools);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error(`mcp request failed: ${String(err)}`);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  // Stateless: no server-initiated streams and no sessions to end.
  app.get("/mcp", (_req, res) => {
    res.status(405).json(METHOD_NOT_ALLOWED);
  });
  app.delete("/mcp", (_req, res) => {
    res.status(405).json(METHOD_NOT_ALLOWED);
  });

  return app;
}

export interface McpServerOptions {
  tools: readonly ToolDefinition[];
  /** Port to bind. `0` lets the OS pick a free one (used by tests). */
  port: number;
  /** Host to bind. Defaults to 127.0.0.1. */
  host?: string;
  /** When set, every request must carry it as a bearer token (P2). */
  token?: string;
}

export interface RunningMcpServer {
  /** Base URL of the MCP endpoint, e.g. `http://127.0.0.1:8090/mcp`. */
  readonly url: string;
  readonly port: number;
  /** Stop the server and resolve once the port is released. */
  close(): Promise<void>;
}

export async function startMcpServer(opts: McpServerOptions): Promise<RunningMcpServer> {
  const host = opts.host ?? "127.0.0.1";
  const app = createMcpApp(opts.tools, { token: opts.token });

  const server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(opts.port, host, () => resolve(s));
    s.once("error", reject);
  });

  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : opts.port;

  return {
    url: `http://${host}:${port}/mcp`,
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
