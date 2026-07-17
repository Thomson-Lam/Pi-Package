import assert from "node:assert/strict";
import { applySkillProfile, normalizeModeSkillIds, selectModeSkillIds } from "../mode-policy.js";

const order = [
  "ponytail",
  "authoring-skills",
  "cindex",
  "handoff",
  "ipynb-toolshed",
  "tmux-tdl-logs",
  "yagni-product-design",
];
const defaults = ["ponytail", "cindex", "handoff"];

assert.deepEqual(
  selectModeSkillIds([], "build", order),
  defaults,
  "Build mode should enable Ponytail, cindex, and handoff",
);
assert.deepEqual(
  normalizeModeSkillIds(["authoring-skills"], "build", order),
  ["authoring-skills"],
  "Build skills should remain independently toggleable after activation",
);
assert.deepEqual(
  selectModeSkillIds(defaults, "spec", order),
  [...defaults, "yagni-product-design"],
  "Spec mode should enable its YAGNI scope guard",
);
assert.deepEqual(
  selectModeSkillIds([...defaults, "yagni-product-design"], "build", order),
  defaults,
  "Build mode should disable the Spec-owned skill",
);
assert.deepEqual(
  selectModeSkillIds([...defaults, "yagni-product-design"], "off", order),
  defaults,
  "Off mode should disable the Spec-owned skill",
);
assert.deepEqual(
  normalizeModeSkillIds(defaults, "spec", order),
  [...defaults, "yagni-product-design"],
  "Spec mode should require its scope guard",
);
assert.deepEqual(
  selectModeSkillIds(defaults, "off", order),
  defaults,
  "Off mode should preserve enabled skills",
);
assert.deepEqual(
  applySkillProfile(["ponytail", "authoring-skills", "cindex"], "off", order),
  ["authoring-skills", "cindex"],
  "Turning profiles off should preserve standalone skills",
);
assert.deepEqual(
  applySkillProfile(["authoring-skills", "cindex"], "ponytail", order),
  ["ponytail", "authoring-skills", "cindex"],
  "Ponytail profile should preserve standalone skills",
);

console.log("muon mode policy checks passed");
