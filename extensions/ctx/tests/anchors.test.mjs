import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./helpers.mjs";

const anchors = await load("../src/anchors.ts");

function msg(id, role, content = `${role} ${id}`) {
  return { type: "message", id, parentId: null, timestamp: new Date().toISOString(), message: { role, content } };
}

function custom(id) {
  return { type: "custom", id, parentId: null, timestamp: new Date().toISOString() };
}

test("findLatestMessageEntry returns latest matching role", () => {
  const entries = [msg("u1", "user"), msg("a1", "assistant"), custom("c1"), msg("u2", "user"), msg("a2", "assistant")];
  assert.equal(anchors.findLatestMessageEntry(entries, "assistant")?.id, "a2");
  assert.equal(anchors.findLatestMessageEntry(entries, "user")?.id, "u2");
});

test("findLatestMessageEntry returns undefined when missing", () => {
  assert.equal(anchors.findLatestMessageEntry([msg("u1", "user")], "assistant"), undefined);
});

test("collectAnchors includes only entries with native labels", () => {
  const entries = [msg("u1", "user", "hello there"), msg("a1", "assistant", "answer here"), custom("c1")];
  const labels = new Map([["u1", "start"], ["a1", "answer"]]);
  const sessionManager = {
    getEntries: () => entries,
    getLabel: (id) => labels.get(id),
  };
  assert.deepEqual(anchors.collectAnchors(sessionManager).map((a) => [a.id, a.label, a.preview]), [
    ["u1", "start", "hello there"],
    ["a1", "answer", "answer here"],
  ]);
});

test("validateLabel rejects empty newline long and duplicate labels", () => {
  assert.equal(anchors.validateLabel("   ", []).ok, false);
  assert.equal(anchors.validateLabel("a\nb", []).ok, false);
  assert.equal(anchors.validateLabel("x".repeat(81), []).ok, false);
  assert.equal(anchors.validateLabel("same", ["same"]).ok, false);
});

test("validateLabel accepts and trims normal labels", () => {
  assert.deepEqual(anchors.validateLabel("  mine  ", ["other"]), { ok: true, label: "mine" });
});

test("labelLatestMessage labels latest assistant on active branch", async () => {
  const calls = [];
  const pi = { setLabel: (...args) => calls.push(args) };
  const ctx = {
    sessionManager: {
      getEntries: () => [msg("old", "assistant")],
      getBranch: () => [msg("a1", "assistant"), msg("u1", "user"), msg("a2", "assistant")],
      getLabel: () => undefined,
    },
    ui: { notify() {} },
  };
  await anchors.labelLatestMessage(pi, ctx, "foo", "assistant");
  assert.deepEqual(calls, [["a2", "foo"]]);
});

test("labelLatestMessage rejects duplicates before setting label", async () => {
  const calls = [];
  const notifications = [];
  const pi = { setLabel: (...args) => calls.push(args) };
  const ctx = {
    sessionManager: {
      getEntries: () => [msg("u1", "user")],
      getBranch: () => [msg("u1", "user")],
      getLabel: () => "foo",
    },
    ui: { notify: (...args) => notifications.push(args) },
  };
  await anchors.labelLatestMessage(pi, ctx, "foo", "user");
  assert.deepEqual(calls, []);
  assert.match(notifications[0][0], /already exists/);
});
