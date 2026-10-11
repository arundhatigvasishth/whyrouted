/**
 * `/mcp` authentication (P2 / P11, M5b).
 *
 * One shared bearer token, `WR_MCP_TOKEN`, required on every request to the
 * MCP endpoint when it is set. Shape and rules fixed by
 * docs/milestones/m5b/shared-contract.md, P2.
 *
 * What this is and is not: one shared secret says "someone with the token",
 * not who, so it is not an audit trail (per-user identity is M8). It is plain
 * HTTP, so on a non-loopback bind the token is readable on the network until
 * TLS arrives in M8. The unsafe configuration is made impossible instead of
 * documented: with no token on a non-loopback bind the five action tools are
 * not registered at all (`actionToolsAllowed`).
 *
 * The token is never logged, echoed, or put in an error.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";

/** Hosts that mean "this machine only". Anything else is treated as reachable from elsewhere. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

/** True for `127.0.0.1`, `::1`, and `localhost` (trimmed, case-insensitive). `0.0.0.0` is not loopback. */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase());
}

const sha256 = (text: string): Buffer => createHash("sha256").update(text, "utf8").digest();

/**
 * Whether an `Authorization` header carries `token`. The scheme is `Bearer`
 * (any case) followed by one space and the token; anything else is a wrong
 * token. Both sides are hashed first so the compare is constant time and never
 * throws or leaks length on a mismatch.
 */
export function bearerMatches(header: string | undefined, token: string): boolean {
  if (header === undefined || token === "") return false;
  const m = /^bearer (.+)$/i.exec(header);
  if (m === null) return false;
  return timingSafeEqual(sha256(m[1]!), sha256(token));
}

/**
 * Express middleware: `401` unless the request carries the token. A missing
 * token and a wrong one get the identical response, so the endpoint does not
 * say which was wrong. Installed first, so it runs before body parsing and
 * before any route, including the 405 handlers.
 */
export function createAuthMiddleware(token: string): RequestHandler {
  return (req, res, next) => {
    if (bearerMatches(req.headers.authorization, token)) {
      next();
      return;
    }
    res.status(401).set("WWW-Authenticate", "Bearer").json({ error: "unauthorized" });
  };
}

export type ActionPolicy = { allowed: true } | { allowed: false; reason: string };

/**
 * Whether the five action tools may be registered for this bind and token.
 * With a token they may, on any bind. Without one, only on a loopback bind.
 */
export function actionToolsAllowed(opts: {
  host: string;
  token: string | undefined;
}): ActionPolicy {
  if (opts.token !== undefined && opts.token !== "") return { allowed: true };
  if (isLoopbackHost(opts.host)) return { allowed: true };
  return {
    allowed: false,
    reason: `action tools are not registered: the MCP server is bound to ${opts.host} with no token. Set WR_MCP_TOKEN (at least 16 characters) to enable them.`,
  };
}

/**
 * The auth lines for the startup banner. They say whether a token is
 * required, never what it is, and warn when a token would travel over plain
 * HTTP on a non-loopback bind.
 */
export function authBanner(opts: { host: string; token: string | undefined }): string[] {
  const hasToken = opts.token !== undefined && opts.token !== "";
  const loopback = isLoopbackHost(opts.host);
  if (hasToken) {
    return loopback
      ? ["auth: token required"]
      : ["auth: token required", "plain http: token is readable on the network"];
  }
  return loopback
    ? ["auth: none (loopback only)"]
    : ["auth: none, read tools only (action tools are not registered)"];
}
