import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(new URL("../../..", import.meta.url).pathname);
const blink = join(root, "extensions", "blink");
const required = [
  "index.ts",
  "tools.ts",
  "revisions.ts",
  "runtime.ts",
  "protocol.ts",
  "tmux.ts",
  "nvim/review.lua",
  "nvim/lua/blink/protocol.lua",
  "nvim/lua/blink/state.lua",
  "nvim/lua/blink/ui.lua",
];
for (const path of required) assert.equal(existsSync(join(blink, path)), true, `missing Blink asset: ${path}`);

const index = readFileSync(join(blink, "index.ts"), "utf8");
assert.match(index, /registerCommand\("blink"/);
assert.match(index, /"off"/);
assert.match(index, /"slow"/);
assert.match(index, /"blitz"/);
assert.match(index, /createEditToolDefinition/);
assert.match(index, /createWriteToolDefinition/);

const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
assert.deepEqual(manifest.pi.extensions, ["./extensions/*/index.ts"], "root wildcard must discover Blink exactly once");

const planModeExists = existsSync(join(root, "extensions", "plan-mode", "index.ts"));
if (!planModeExists) {
  const userDocs = `${readFileSync(join(root, "README.md"), "utf8")}\n${readFileSync(join(root, "manual.md"), "utf8")}`;
  assert.doesNotMatch(userDocs, /plan_diff|\/p(?:new|attach|detach|mode)|plan-mode/i, "removed plan-mode references remain in user docs");
}

console.log(`blink structural smoke passed (${planModeExists ? "pre-migration" : "post-migration"})`);
