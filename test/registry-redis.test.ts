import { describe, it, expect } from "vitest";
import { RedisRegistry } from "../src/registry/redis.js";

describe("RedisRegistry (stub)", () => {
  it("throws not-implemented on every method", () => {
    const reg = new RedisRegistry();
    expect(() => reg.register({ id: "replica-1", url: "http://x" })).toThrow(/not implemented/i);
    expect(() => reg.updateRuntime("replica-1", { inFlight: 1 })).toThrow(/not implemented/i);
    expect(() => reg.setHealth("replica-1", "healthy")).toThrow(/not implemented/i);
    expect(() => reg.getSnapshot()).toThrow(/not implemented/i);
  });
});
