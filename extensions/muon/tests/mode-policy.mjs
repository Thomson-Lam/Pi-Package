import assert from "node:assert/strict";
import { applySkillProfile, normalizeModeSkillIds, selectModeSkillIds } from "../mode-policy.js";

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
const defaults = ["ponytail", "cindex", "handoff"];

assert.deepEqual(
  selectModeSkillIds(defaults, "engineering", order),
  ["ponytail", "engineering", "cindex", "handoff"],
  "Engineering mode should preserve Ponytail and standalone skills",
);
assert.deepEqual(
  selectModeSkillIds(["ponytail", "engineering", "authoring-skills", "cindex"], "foundation", order),
  ["ponytail", "foundation", "authoring-skills", "cindex"],
  "Foundation mode should replace Engineering and preserve standalone skills",
);
assert.deepEqual(
  selectModeSkillIds(["ponytail", "foundation", "cindex", "handoff"], "off", order),
  defaults,
  "Off mode should remove both mode-owned bundles",
);
assert.deepEqual(
  normalizeModeSkillIds(["engineering", "cindex"], "off", order),
  ["engineering", "cindex"],
  "Off mode should allow a manually exposed Engineering profile",
);
assert.deepEqual(
  normalizeModeSkillIds(["foundation", "cindex"], "engineering", order),
  ["engineering", "cindex"],
  "An active mode should enforce its own bundle",
);
assert.deepEqual(
  applySkillProfile(["ponytail", "authoring-skills", "cindex"], "engineering", order),
  ["engineering", "authoring-skills", "cindex"],
  "Skill profile shortcuts should preserve standalone skills",
);

console.log("muon mode policy checks passed");
