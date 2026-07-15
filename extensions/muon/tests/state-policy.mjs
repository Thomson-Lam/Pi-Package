import assert from "node:assert/strict";
import { normalizeModeSkillIds } from "../mode-policy.js";
import { restoreConfigFromEntries } from "../state-policy.js";

const order = [
  "ponytail",
  "engineering",
  "foundation",
  "authoring-skills",
  "cindex",
  "handoff",
  "ipynb-toolshed",
  "tmux-tdl-logs",
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
const initial = { mode: "off", enabledSkills: ["ponytail", "cindex", "handoff"] };
const custom = (customType, data) => ({ type: "custom", customType, data });

assert.deepEqual(
  restoreConfigFromEntries([
    custom("muon-state", { config: { mode: "engineering", enabledSkills: ["ponytail", "engineering", "cindex"] } }),
  ], initial, policies),
  { mode: "engineering", enabledSkills: ["ponytail", "engineering", "cindex"] },
  "current Muon state should restore",
);

assert.deepEqual(
  restoreConfigFromEntries([
    custom("foundation-mode-state", { enabled: true }),
    custom("muon-state", { config: { enabledSkills: ["ponytail", "cindex", "handoff"] } }),
  ], initial, policies),
  { mode: "foundation", enabledSkills: ["ponytail", "foundation", "cindex", "handoff"] },
  "enabled legacy Foundation state should migrate across reload",
);

assert.deepEqual(
  restoreConfigFromEntries([
    custom("muon-state", { config: { mode: "off", enabledSkills: ["engineering", "authoring-skills"] } }),
  ], initial, policies),
  { mode: "off", enabledSkills: ["engineering", "authoring-skills"] },
  "off mode should retain a manually exposed mode skill profile",
);

assert.deepEqual(
  restoreConfigFromEntries([
    custom("muon-state", { config: { skillset: "auto" } }),
    custom("foundation-mode-state", { enabled: false }),
  ], initial, policies),
  { mode: "off", enabledSkills: ["ponytail"] },
  "legacy Muon and disabled Foundation state should migrate",
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
