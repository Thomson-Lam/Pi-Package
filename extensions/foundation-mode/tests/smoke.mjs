import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const extensionDir = resolve(new URL("..", import.meta.url).pathname);
const indexPath = join(extensionDir, "index.ts");
const promptPath = join(extensionDir, "foundation-prompt.md");

assert.equal(existsSync(indexPath), true, "missing foundation-mode/index.ts");
assert.equal(existsSync(promptPath), true, "missing foundation-prompt.md");

const index = readFileSync(indexPath, "utf8");
assert.match(index, /registerCommand\("foundation-mode"/);
assert.match(index, /before_agent_start/);
assert.match(index, /event\.systemPrompt/);
assert.match(index, /foundationMode = false/);
assert.match(index, /setStatus/);

const prompt = readFileSync(promptPath, "utf8");
assert.match(prompt, /^# Foundation Mode/);
assert.match(prompt, /### Mode D — Prompt-Governed Mechanics/);
assert.match(prompt, /### Mode A — Strict Apprenticeship by Default/);
assert.match(prompt, /### Mode C — Adaptive Progression/);
assert.match(prompt, /### Mode B — Earned Guided Pairing/);
assert.match(prompt, /## Documentation-First Learning/);
assert.match(prompt, /\| Command run \| Result \|/);
assert.match(prompt, /## Teach-Back Gate/);
assert.match(prompt, /## Offloading Disguises/);

console.log("foundation-mode smoke tests passed");
