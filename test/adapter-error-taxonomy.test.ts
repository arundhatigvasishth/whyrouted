import { describe, it, expect } from "vitest";
import { ReplicaRequestError } from "../src/adapter/types.js";

describe("ReplicaRequestError.retryable", () => {
  it("timeout is always retryable", () => {
    expect(new ReplicaRequestError("timeout", "timed out").retryable).toBe(true);
  });

  it("connection is always retryable", () => {
    expect(new ReplicaRequestError("connection", "refused").retryable).toBe(true);
  });

  it("a 5xx http_status is retryable", () => {
    expect(new ReplicaRequestError("http_status", "server error", 503).retryable).toBe(true);
    expect(new ReplicaRequestError("http_status", "server error", 500).retryable).toBe(true);
  });

  it("a 4xx http_status is not retryable", () => {
    expect(new ReplicaRequestError("http_status", "bad request", 400).retryable).toBe(false);
    expect(new ReplicaRequestError("http_status", "not found", 404).retryable).toBe(false);
  });

  it("extends Error so existing generic catches still work", () => {
    const err = new ReplicaRequestError("timeout", "timed out");
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("timed out");
  });
});
