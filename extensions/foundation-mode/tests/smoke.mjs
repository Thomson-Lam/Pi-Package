import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const extensionDir = resolve(new URL("..", import.meta.url).pathname);
const indexPath = join(extensionDir, "index.ts");
const promptPath = join(extensionDir, "foundation-prompt.md");
const cavemanPath = join(extensionDir, "skills", "caveman", "SKILL.md");

assert.equal(existsSync(indexPath), true, "missing foundation-mode/index.ts");
assert.equal(existsSync(promptPath), true, "missing foundation-prompt.md");
assert.equal(existsSync(cavemanPath), true, "missing human-invoked caveman skill");

const index = readFileSync(indexPath, "utf8");
assert.match(index, /registerCommand\("foundation-mode"/);
assert.match(index, /before_agent_start/);
assert.match(index, /event\.systemPrompt/);
assert.match(index, /foundationMode = false/);
assert.match(index, /setStatus/);
assert.match(index, /resources_discover/);
assert.match(index, /foundationMode\s*\?\s*\{ skillPaths/);
assert.match(index, /FOUNDATION_STATE_ENTRY_TYPE/);
assert.match(index, /appendEntry/);
assert.match(index, /event\.reason === "reload"/);
assert.match(index, /await ctx\.reload\(\)/);

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

const caveman = readFileSync(cavemanPath, "utf8");
assert.match(caveman, /name: caveman/);
assert.match(caveman, /disable-model-invocation: true/);
assert.match(caveman, /Foundation Mode always takes precedence/);
assert.match(caveman, /\*\*Lite\*\*/);
assert.match(caveman, /\*\*Full\*\*/);
assert.match(caveman, /\*\*Ultra\*\*/);
assert.doesNotMatch(caveman, /wenyan/i);
assert.doesNotMatch(caveman, /65%/);

console.log("foundation-mode smoke tests passed");
