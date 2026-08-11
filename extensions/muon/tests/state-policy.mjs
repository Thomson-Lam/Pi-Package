import assert from "node:assert/strict";
import { normalizeModeSkillIds } from "../mode-policy.js";
import { restoreConfigFromEntries } from "../state-policy.js";

const order = [
  "ponytail",
  "authoring-skills",
  "cindex",
  "github-issues-prs",
  "handoff",
  "ipynb-toolshed",
  "tmux-tdl-logs",
  "yagni-product-design",
];
const valid = new Set(order);
const policies = {
  normalizeSkillIds(values) {
    const enabled = new Set(values.filter((id) => valid.has(id)));
    return order.filter((id) => enabled.has(id));
  },
  normalizeModeSkillIds(values, mode) {
    return normalizeModeSkillIds(values, mode, order);
  },
};
const initial = {
  mode: "off",
  enabledSkills: ["ponytail", "cindex", "github-issues-prs", "handoff", "tmux-tdl-logs"],
};
const custom = (customType, data) => ({ type: "custom", customType, data });

assert.deepEqual(
  restoreConfigFromEntries([
    custom("muon-state", { config: { mode: "build", enabledSkills: [] } }),
  ], initial, policies),
  { mode: "build", enabledSkills: [] },
  "Build mode should restore explicitly toggled skills",
);

assert.deepEqual(
  restoreConfigFromEntries([
    custom("muon-state", { config: { mode: "spec", enabledSkills: [] } }),
  ], initial, policies),
  { mode: "spec", enabledSkills: ["yagni-product-design"] },
  "Spec mode should restore with its required scope guard",
);

assert.deepEqual(
  restoreConfigFromEntries([
    custom("muon-state", { config: { mode: "off", enabledSkills: ["authoring-skills", "cindex"] } }),
  ], initial, policies),
  { mode: "off", enabledSkills: ["authoring-skills", "cindex"] },
  "current Muon state should restore",
);

assert.deepEqual(
  restoreConfigFromEntries([
    custom("muon-state", { config: { skillset: "auto" } }),
  ], initial, policies),
  { mode: "off", enabledSkills: ["ponytail"] },
  "legacy Muon state should migrate",
);

assert.deepEqual(
  restoreConfigFromEntries([
    custom("muon-state", { config: { enabledSkills: ["superpowers", "cindex"] } }),
    custom("other", { enabled: true }),
    { type: "custom", customType: "muon-state", data: null },
  ], initial, policies),
  { mode: "off", enabledSkills: ["cindex"] },
  "retired and malformed state should be ignored safely",
);

console.log("muon state policy checks passed");
