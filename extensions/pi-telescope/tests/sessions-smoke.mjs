import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const telescopeDir = resolve(new URL("..", import.meta.url).pathname);
const provider = readFileSync(resolve(telescopeDir, "providers/sessions.ts"), "utf8");

test("sessions provider opens a focused resume/rename/delete action menu", () => {
	assert.match(provider, /enterOpensActions: true/);
	assert.match(provider, /label: "Resume"/);
	assert.match(provider, /label: "Rename"/);
	assert.match(provider, /label: "Delete"/);
	assert.match(provider, /Cannot delete the currently active session/);
	assert.match(provider, /Trash unavailable/);
	assert.doesNotMatch(provider, /label: "Copy path"/);
});
