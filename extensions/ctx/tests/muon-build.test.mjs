import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./helpers.mjs";

const { composeMuonBuildSetup, resolveMuonBuildSetupEntry } = await load("../src/fresh/muon-build.ts");

const modules = {
  MUON_STATE_ENTRY_TYPE: "muon-state",
  restoreMuonState: (ctx) => ({ config: { enabledSkills: ["ponytail", "tmux-tdl-logs"] } }),
  selectModeSkillIds: (values, mode) => [...values, "build-skill"],
  createInitialMuonState: () => ({ config: { enabledSkills: ["ponytail"] } }),
};

test("composeMuonBuildSetup writes a build-mode muon-state entry", () => {
  const entries = [];
  const appender = composeMuonBuildSetup(modules, {});
  assert.equal(typeof appender, "function");
  appender({ appendCustomEntry: (type, data) => entries.push([type, data]) });
  assert.equal(entries[0][0], "muon-state");
  assert.equal(entries[0][1].config.mode, "build");
  assert.deepEqual(entries[0][1].config.enabledSkills, ["ponytail", "tmux-tdl-logs", "build-skill"]);
  assert.equal(typeof entries[0][1].updatedAt, "number");
});

test("composeMuonBuildSetup falls back to initial skills when restore throws", () => {
  const bad = { ...modules, restoreMuonState: () => { throw new Error("corrupt entries"); } };
  const appender = composeMuonBuildSetup(bad, {});
  let data;
  appender({ appendCustomEntry: (_type, entry) => { data = entry; } });
  assert.equal(data.config.mode, "build");
  assert.deepEqual(data.config.enabledSkills, ["ponytail"]);
});

test("composeMuonBuildSetup keeps current skills when the sync function is missing", () => {
  const partial = { ...modules, selectModeSkillIds: undefined };
  const appender = composeMuonBuildSetup(partial, {});
  let data;
  appender({ appendCustomEntry: (_type, entry) => { data = entry; } });
  assert.deepEqual(data.config.enabledSkills, ["ponytail", "tmux-tdl-logs"]);
});

test("composeMuonBuildSetup returns undefined when nothing usable is left", () => {
  const broken = {
    ...modules,
    selectModeSkillIds: undefined,
    restoreMuonState: () => { throw new Error("corrupt"); },
    createInitialMuonState: () => { throw new Error("missing"); },
  };
  assert.equal(composeMuonBuildSetup(broken, {}), undefined);
});

test("resolveMuonBuildSetupEntry loads the real muon modules end-to-end", async () => {
  const ctx = { sessionManager: { getEntries: () => [] } };
  const appender = await resolveMuonBuildSetupEntry(ctx);
  assert.equal(typeof appender, "function");
  const entries = [];
  appender({ appendCustomEntry: (type, data) => entries.push([type, data]) });
  assert.equal(entries[0][0], "muon-state");
  assert.equal(entries[0][1].config.mode, "build");
  assert.deepEqual(entries[0][1].config.enabledSkills, [
    "ponytail",
    "cindex",
    "github-issues-prs",
    "tmux-tdl-logs",
  ]);
});
