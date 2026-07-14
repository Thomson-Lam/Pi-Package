import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const telescopeDir = resolve(new URL("..", import.meta.url).pathname);
const index = readFileSync(resolve(telescopeDir, "index.ts"), "utf8");
const provider = readFileSync(resolve(telescopeDir, "providers/hotkeys.ts"), "utf8");

test("hotkeys provider and launcher are registered", () => {
	assert.match(index, /"help":\s+\(\) => createHotkeysProvider/);
	assert.match(index, /"help": \["ctrl\+alt\+z"\]/);
	assert.match(index, /registerCommand\("telescope-hotkeys"/);
	assert.match(provider, /getEffectiveConfig/);
	assert.match(provider, /name: "help"/);
	assert.match(provider, /telescope\.help/);
});
