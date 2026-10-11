import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { actionToolsAllowed, authBanner, bearerMatches, isLoopbackHost } from "../src/mcp/auth.js";
import { defineTool, startMcpServer, type RunningMcpServer } from "../src/mcp/server.js";

const TOKEN = "correct-horse-battery-staple";

describe("isLoopbackHost", () => {
  it("accepts the three loopback names, trimmed and case-insensitive", () => {
    for (const h of ["127.0.0.1", "::1", "localhost", " LocalHost ", "LOCALHOST"]) {
      expect(isLoopbackHost(h), h).toBe(true);
    }
  });

  it("rejects 0.0.0.0, :: and everything else, because they are reachable from elsewhere", () => {
    for (const h of ["0.0.0.0", "::", "192.168.1.5", "example.com", "127.0.0.2", ""]) {
      expect(isLoopbackHost(h), h).toBe(false);
    }
  });
});

describe("bearerMatches", () => {
  it("matches the right token, with the scheme in any case", () => {
    expect(bearerMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(bearerMatches(`bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(bearerMatches(`BEARER ${TOKEN}`, TOKEN)).toBe(true);
  });

  it("rejects a missing header, a wrong token, and a token that is only a prefix or extension", () => {
    expect(bearerMatches(undefined, TOKEN)).toBe(false);
    expect(bearerMatches("Bearer wrong", TOKEN)).toBe(false);
    expect(bearerMatches(`Bearer ${TOKEN.slice(0, -1)}`, TOKEN)).toBe(false);
    expect(bearerMatches(`Bearer ${TOKEN}x`, TOKEN)).toBe(false);
  });

  it("rejects other schemes, a missing space, and an empty token", () => {
    expect(bearerMatches(`Basic ${TOKEN}`, TOKEN)).toBe(false);
    expect(bearerMatches(`Bearer${TOKEN}`, TOKEN)).toBe(false);
    expect(bearerMatches(TOKEN, TOKEN)).toBe(false);
    expect(bearerMatches("Bearer ", TOKEN)).toBe(false);
    expect(bearerMatches("", TOKEN)).toBe(false);
  });

  it("never matches when the configured token is empty", () => {
    expect(bearerMatches("Bearer ", "")).toBe(false);
    expect(bearerMatches("Bearer x", "")).toBe(false);
  });

  it("does not throw on tokens of different lengths", () => {
    expect(() => bearerMatches("Bearer a", TOKEN)).not.toThrow();
    expect(() => bearerMatches(`Bearer ${"a".repeat(10_000)}`, TOKEN)).not.toThrow();
  });
});

describe("actionToolsAllowed", () => {
  it("allows them on loopback with no token, so the local demo works unchanged", () => {
    for (const host of ["127.0.0.1", "::1", "localhost"]) {
      expect(actionToolsAllowed({ host, token: undefined })).toEqual({ allowed: true });
    }
  });

  it("allows them anywhere once a token is set", () => {
    for (const host of ["127.0.0.1", "0.0.0.0", "192.168.1.5"]) {
      expect(actionToolsAllowed({ host, token: TOKEN })).toEqual({ allowed: true });
    }
  });

  it("refuses them on a non-loopback bind with no token, and says how to fix it", () => {
    for (const host of ["0.0.0.0", "::", "192.168.1.5"]) {
      const policy = actionToolsAllowed({ host, token: undefined });
      expect(policy.allowed).toBe(false);
      if (!policy.allowed) {
        expect(policy.reason).toContain(host);
        expect(policy.reason).toContain("WR_MCP_TOKEN");
      }
    }
  });

  it("treats an empty token as unset", () => {
    expect(actionToolsAllowed({ host: "0.0.0.0", token: "" }).allowed).toBe(false);
  });
});

describe("authBanner", () => {
  it("says a token is required, and never what it is", () => {
    const lines = authBanner({ host: "127.0.0.1", token: TOKEN });
    expect(lines).toEqual(["auth: token required"]);
    expect(lines.join(" ")).not.toContain(TOKEN);
  });

  it("warns that the token is readable on the network for a non-loopback bind", () => {
    expect(authBanner({ host: "0.0.0.0", token: TOKEN })).toEqual([
      "auth: token required",
      "plain http: token is readable on the network",
    ]);
  });

  it("describes the no-token cases honestly", () => {
    expect(authBanner({ host: "127.0.0.1", token: undefined })).toEqual([
      "auth: none (loopback only)",
    ]);
    expect(authBanner({ host: "0.0.0.0", token: undefined })).toEqual([
      "auth: none, read tools only (action tools are not registered)",
    ]);
  });
});

describe("the MCP endpoint with a token", () => {
  let running: RunningMcpServer | undefined;
  let client: Client | undefined;

  afterEach(async () => {
    await client?.close();
    await running?.close();
    client = undefined;
    running = undefined;
  });

  const echo = defineTool({
    name: "echo",
    description: "Echo the id.",
    inputSchema: { id: z.string() },
    handler: ({ id }) => ({ kind: "data", data: { id }, source: "registry", recordIds: [id] }),
  });

  const rpc = (url: string, headers: Record<string, string> = {}) =>
    fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

  it("answers 401 with the same body for a missing token and a wrong one", async () => {
    running = await startMcpServer({ tools: [echo], port: 0, token: TOKEN });
    const missing = await rpc(running.url);
    const wrong = await rpc(running.url, { authorization: "Bearer not-the-token" });
    for (const res of [missing, wrong]) {
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe("Bearer");
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
  });

  it("rejects GET and DELETE with 401, not 405, when there is no token", async () => {
    running = await startMcpServer({ tools: [echo], port: 0, token: TOKEN });
    for (const method of ["GET", "DELETE"]) {
      expect((await fetch(running.url, { method })).status, method).toBe(401);
    }
  });

  it("rejects before parsing the body: malformed JSON with no token is 401, not 400", async () => {
    running = await startMcpServer({ tools: [echo], port: 0, token: TOKEN });
    const res = await fetch(running.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ not json",
    });
    expect(res.status).toBe(401);
  });

  it("rejects every path, not only /mcp", async () => {
    running = await startMcpServer({ tools: [echo], port: 0, token: TOKEN });
    const base = new URL(running.url).origin;
    for (const path of ["/.well-known/oauth-protected-resource", "/register", "/anything"]) {
      expect((await fetch(base + path)).status, path).toBe(401);
    }
  });

  it("lets a client with the right token connect and call a tool", async () => {
    running = await startMcpServer({ tools: [echo], port: 0, token: TOKEN });
    client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(running.url), {
        requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
      }),
    );
    const res = await client.callTool({ name: "echo", arguments: { id: "r1" } });
    expect(res.isError).toBe(false);
  });

  it("does not echo the token in a 401 body", async () => {
    running = await startMcpServer({ tools: [echo], port: 0, token: TOKEN });
    const res = await rpc(running.url, { authorization: `Bearer ${TOKEN}x` });
    expect(await res.text()).not.toContain(TOKEN);
  });

  it("requires nothing when no token is configured, as in M5a", async () => {
    running = await startMcpServer({ tools: [echo], port: 0 });
    client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(running.url)));
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["echo"]);
  });
});
