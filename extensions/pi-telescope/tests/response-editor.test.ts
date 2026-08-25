import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { resolvePlanningPath } from "../response-editor.ts";

test("resolves response names under docs/planning", () => {
	assert.equal(
		resolvePlanningPath("/workspace/project", "architecture"),
		"/workspace/project/docs/planning/architecture.md",
	);
	assert.equal(
		resolvePlanningPath("/workspace/project", "notes.txt"),
		"/workspace/project/docs/planning/notes.txt",
	);
});

test("resolves a file name under a custom directory", () => {
	assert.equal(
		resolvePlanningPath("/workspace/project", "architecture", "docs/ideas"),
		"/workspace/project/docs/ideas/architecture.md",
	);
});

test("rejects paths instead of file names", () => {
	for (const name of ["", ".", "..", "../escape.md", "nested/file.md", "nested\\file.md"]) {
		assert.equal(resolvePlanningPath("/workspace/project", name), undefined);
	}
});

test("offers the Neovim action only for one agent response", () => {
	const provider = readFileSync(new URL("../providers/session-tree.ts", import.meta.url), "utf8");
	assert.match(provider, /items\.length === 1 && items\[0\]\?\.kind === "agent"/);
	assert.match(provider, /key: "e", label: "Edit and save response"/);
	assert.match(provider, /editResponseInNvim\(item\.previewText, ctx\)/);
});
