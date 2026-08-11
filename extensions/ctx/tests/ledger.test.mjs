import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./helpers.mjs";

const { buildReadLedger, normalizeReadPath } = await load("../src/fresh/ledger.ts");

function assistant(id, calls) {
  return { type: "message", id, parentId: null, timestamp: new Date().toISOString(), message: { role: "assistant", content: calls.map((call) => ({ type: "toolCall", id: call.id, name: "read", arguments: call.args })) } };
}
function result(id, toolCallId, isError = false) {
  return { type: "message", id, parentId: null, timestamp: new Date().toISOString(), message: { role: "toolResult", toolCallId, toolName: "read", content: [{ type: "text", text: "content" }], isError, timestamp: Date.now() } };
}

test("active-branch successful reads are normalized and deduplicated", () => {
  const branch = [
    assistant("a", [
      { id: "one", args: { path: "src/a.ts", offset: 10, limit: 20 } },
      { id: "two", args: { path: "./src/a.ts" } },
      { id: "outside", args: { path: "../secret" } },
      { id: "failed", args: { path: "src/failed.ts" } },
      { id: "pending", args: { path: "src/pending.ts" } },
    ]),
    result("r1", "one"),
    result("r2", "two"),
    result("r3", "outside"),
    result("r4", "failed", true),
  ];
  const ledger = buildReadLedger(branch, "/project");
  assert.deepEqual(ledger.candidates.map((candidate) => candidate.path), ["src/a.ts"]);
});

test("normalization accepts project paths and rejects the root or outside paths", () => {
  assert.equal(normalizeReadPath("@/project/src/a.ts", "/project")?.path, "src/a.ts");
  assert.equal(normalizeReadPath(".", "/project"), undefined);
  assert.equal(normalizeReadPath("../other.ts", "/project"), undefined);
});
