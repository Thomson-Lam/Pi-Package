import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./helpers.mjs";

const { createPreparedSession, runFreshContextSession } = await load("../src/fresh/transition.ts");

const prepared = {
  selectedPaths: ["src/a.ts"],
  included: [{ path: "src/a.ts", absolutePath: "/project/src/a.ts", content: "current", bytes: 7, estimatedTokens: 2, sha256: "hash" }],
  excluded: [],
  totalBytes: 7,
  estimatedTokens: 2,
};

test("prepared session appends context before submitting the exact objective", async () => {
  const events = [];
  const ctx = {
    sessionManager: { getSessionFile: () => "/sessions/source.jsonl" },
    ui: { notify() {}, setEditorText() {} },
    async newSession(options) {
      assert.equal(options.parentSession, "/sessions/source.jsonl");
      await options.setup({ appendCustomMessageEntry(type, content, display, details) { events.push(["context", type, content, display, details]); } });
      await options.withSession({
        ui: { notify() {}, setEditorText() {} },
        async sendUserMessage(objective) { events.push(["objective", objective]); },
      });
      return { cancelled: false };
    },
  };
  const outcome = await createPreparedSession(ctx, prepared, "  exact objective\n");
  assert.equal(outcome.status, "completed");
  assert.equal(events[0][0], "context");
  assert.equal(events[0][1], "ctx:fresh-files");
  assert.equal(events[1][0], "objective");
  assert.equal(events[1][1], "  exact objective\n");
});

test("empty active-branch ledger never creates a session", async () => {
  let created = false;
  const notifications = [];
  const pi = { sendUserMessage() {} };
  const ctx = {
    mode: "tui",
    model: { contextWindow: 200_000 },
    cwd: "/project",
    ui: { notify: (...args) => notifications.push(args) },
    waitForIdle: async () => {},
    sessionManager: { getBranch: () => [] },
    newSession: async () => { created = true; return { cancelled: false }; },
  };
  const outcome = await runFreshContextSession(pi, ctx);
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.stage, "ledger");
  assert.equal(created, false);
  assert.match(notifications[0][0], /No successful file reads/);
});
