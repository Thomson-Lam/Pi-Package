import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const extensionDir = resolve(new URL("..", import.meta.url).pathname);
const index = readFileSync(resolve(extensionDir, "index.ts"), "utf8");
const client = readFileSync(resolve(extensionDir, "client.lua"), "utf8");

assert.match(index, /registerCommand\("fb"/);
assert.match(index, /registerCommand\("fpr"/);
assert.match(index, /"split-window", "-d", "-h", "-f", "-l", "50%"/);
assert.match(index, /ctx\.ui\.setEditorText\(text\)/);
assert.match(index, /createServer/);
assert.match(index, /bufferName\(\)/);
assert.match(index, /shellQuote\(bufferPath\)/);
assert.doesNotMatch(index, /--clean/);
assert.doesNotMatch(index, /writeFile/);
assert.match(client, /BufWriteCmd/);
assert.match(client, /vim\.bo\.filetype = "markdown"/);

console.log("feedback-editor smoke tests passed");
