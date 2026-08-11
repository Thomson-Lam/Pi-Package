import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./helpers.mjs";

const { buildFreshContextMessage } = await load("../src/fresh/context-message.ts");

test("fresh context message contains only included current contents", () => {
  const message = buildFreshContextMessage({
    selectedPaths: ["src/a.ts", "src/missing.ts"],
    included: [{ path: "src/a.ts", absolutePath: "/p/src/a.ts", content: "const current = true;", bytes: 21, estimatedTokens: 6, sha256: "hash" }],
    excluded: [{ path: "src/missing.ts", reason: "missing", detail: "gone" }],
    totalBytes: 21,
    estimatedTokens: 6,
  });
  assert.match(message.content, /src\/a\.ts/);
  assert.match(message.content, /const current = true;/);
  assert.doesNotMatch(message.content, /The user approved|Use the supplied contents|src\/missing\.ts|gone|TODO/);
  assert.deepEqual(message.details.paths, [{ path: "src/a.ts", bytes: 21, estimatedTokens: 6 }]);
});
