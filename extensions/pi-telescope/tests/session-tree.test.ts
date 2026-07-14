import test from "node:test";
import assert from "node:assert/strict";

import { collectSessionTreeItems } from "../session-tree.ts";

const userA = {
	type: "message", id: "user-a", parentId: null, timestamp: "",
	message: { role: "user", content: "start auth work", timestamp: 0 },
};
const agentA = {
	type: "message", id: "agent-a", parentId: "user-a", timestamp: "",
	message: {
		role: "assistant",
		content: [
			{ type: "text", text: "I will inspect auth." },
			{ type: "toolCall", id: "call-read", name: "read", arguments: { path: "src/auth.ts" } },
		],
		stopReason: "toolUse",
	},
};
const readResult = {
	type: "message", id: "result-read", parentId: "agent-a", timestamp: "",
	message: {
		role: "toolResult", toolCallId: "call-read", toolName: "read",
		content: [{ type: "text", text: "export function login() {}" }], isError: false, timestamp: 0,
	},
};
const userB = {
	type: "message", id: "user-b", parentId: "result-read", timestamp: "",
	message: { role: "user", content: "use a cache", timestamp: 0 },
};
const agentB = {
	type: "message", id: "agent-b", parentId: "user-b", timestamp: "",
	message: { role: "assistant", content: [{ type: "text", text: "Cache added." }], stopReason: "stop" },
};
const alternateUser = {
	type: "message", id: "user-alt", parentId: "agent-a", timestamp: "",
	message: { role: "user", content: "do not use a cache", timestamp: 0 },
};
const toolOnlyAgent = {
	type: "message", id: "agent-tool", parentId: "user-alt", timestamp: "",
	message: {
		role: "assistant",
		content: [{ type: "toolCall", id: "call-bash", name: "bash", arguments: { command: "npm test" } }],
		stopReason: "toolUse",
	},
};
const bashResult = {
	type: "message", id: "result-bash", parentId: "agent-tool", timestamp: "",
	message: {
		role: "toolResult", toolCallId: "call-bash", toolName: "bash",
		content: [{ type: "text", text: "12 tests passed" }], isError: false, timestamp: 0,
	},
};

const tree: any[] = [{
	entry: userA,
	children: [{
		entry: agentA,
		label: "inspection",
		children: [
			{ entry: readResult, children: [{ entry: userB, children: [{ entry: agentB, children: [] }] }] },
			{ entry: alternateUser, children: [{ entry: toolOnlyAgent, children: [{ entry: bashResult, children: [] }] }] },
		],
	}],
}];

const sessionManager: any = {
	getTree: () => tree,
	getBranch: () => [userA, agentA, readResult, userB, agentB],
};

test("collects user prompts from every branch", () => {
	const items = collectSessionTreeItems(sessionManager, "user");
	assert.deepEqual(items.map((item) => item.entryId), ["user-a", "user-b", "user-alt"]);
	assert.equal(items.find((item) => item.entryId === "user-b")?.active, true);
	assert.equal(items.find((item) => item.entryId === "user-alt")?.active, false);
});

test("agent mode includes text responses but excludes tool-only assistant messages", () => {
	const items = collectSessionTreeItems(sessionManager, "agent");
	assert.deepEqual(items.map((item) => item.entryId), ["agent-a", "agent-b"]);
	assert.match(items[0]!.searchText, /inspection/);
});

test("tool mode extracts calls, searches arguments and results, and navigates through results", () => {
	const items = collectSessionTreeItems(sessionManager, "tools");
	assert.deepEqual(items.map((item) => item.toolName), ["read", "bash"]);
	assert.equal(items[0]!.navigationTargetId, "result-read");
	assert.equal(items[1]!.navigationTargetId, "result-bash");
	assert.match(items[0]!.searchText, /src\/auth\.ts/);
	assert.match(items[0]!.searchText, /inspection/, "entry labels are searchable");
	assert.match(items[0]!.searchText, /login/);
	assert.match(items[1]!.searchText, /12 tests passed/);
	assert.equal(items[0]!.active, true);
	assert.equal(items[1]!.active, false);
});

test("all mode combines conversation and tool entries", () => {
	const items = collectSessionTreeItems(sessionManager, "all");
	assert.ok(items.some((item) => item.kind === "user"));
	assert.ok(items.some((item) => item.kind === "agent"));
	assert.ok(items.some((item) => item.kind === "tool"));
});
