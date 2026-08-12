import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./helpers.mjs";

const { DEFAULT_FRESH_LIMITS, limitsForContextWindow } = await load("../src/fresh/limits.ts");

test("fresh file context allows up to 100k tokens", () => {
  assert.equal(DEFAULT_FRESH_LIMITS.maxTransferTokens, 100_000);
  assert.equal(limitsForContextWindow(200_000).maxTransferTokens, 100_000);
  assert.equal(limitsForContextWindow(128_000).maxTransferTokens, 64_000);
});
