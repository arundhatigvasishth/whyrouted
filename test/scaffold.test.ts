import { describe, it, expect } from "vitest";

/**
 * Smoke test so the test runner has something to execute and CI goes green
 * before any real modules land. Replace / delete once B6 tests exist.
 */
describe("scaffold", () => {
  it("runs the test runner", () => {
    expect(true).toBe(true);
  });
});
