import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(new URL("../../..", import.meta.url).pathname);
const muonDir = join(root, "extensions", "muon");
const skillsetsDir = join(muonDir, "skillsets");
const modesDir = join(muonDir, "modes");

for (const file of [
  "index.ts",
  "constants.ts",
  "types.ts",
  "state.ts",
  "resources.ts",
  "command-parser.js",
  "command-parser.d.ts",
  "mode-policy.js",
  "mode-policy.d.ts",
  "state-policy.js",
  "state-policy.d.ts",
  "skills.ts",
  "commands.ts",
  "skill-dump.ts",
  "README.md",
  "modes/engineering-prompt.md",
  "modes/foundation-prompt.md",
]) {
  assert.equal(existsSync(join(muonDir, file)), true, `missing ${file}`);
}

assert.equal(existsSync(join(muonDir, "superpowers.ts")), false, "stale superpowers resource module remains");
assert.equal(existsSync(join(skillsetsDir, "muon", "using-muon", "SKILL.md")), false, "stale using-muon skill remains");
assert.equal(existsSync(join(skillsetsDir, "superpowers")), false, "Superpowers should not remain in Muon's active skillsets");
assert.equal(existsSync(join(root, "extensions", "foundation-mode", "index.ts")), false, "separate Foundation entrypoint remains");
assert.equal(existsSync(join(root, "extensions", "superpowers", "legacy", "skillsets", "superpowers")), true, "missing legacy Superpowers archive");

for (const path of [
  ["ponytail", "ponytail"],
  ["ponytail", "ponytail-review"],
  ["ponytail", "ponytail-debt"],
  ["engineering", "brainstorming"],
  ["engineering", "planning-risky-changes"],
  ["engineering", "systematic-debugging"],
  ["foundation", "caveman"],
  ["standalone", "authoring-skills"],
  ["standalone", "cindex"],
  ["standalone", "handoff"],
  ["standalone", "ipynb_toolshed"],
  ["standalone", "tmux-tdl-logs"],
]) {
  assert.equal(existsSync(join(skillsetsDir, ...path, "SKILL.md")), true, `missing skill ${path.join("/")}`);
}

for (const skill of ["ponytail", "ponytail-review", "ponytail-debt"]) {
  const content = readFileSync(join(skillsetsDir, "ponytail", skill, "SKILL.md"), "utf8");
  assert.doesNotMatch(content, /using-muon/, `${skill} still routes through using-muon`);
}

const engineeringPrompt = readFileSync(join(modesDir, "engineering-prompt.md"), "utf8");
const foundationPrompt = readFileSync(join(modesDir, "foundation-prompt.md"), "utf8");
assert.match(engineeringPrompt, /^You are operating in Muon Engineering Mode/);
assert.match(engineeringPrompt, /## Skill Invocation Policy/);
assert.match(foundationPrompt, /^# Foundation Mode/);
assert.match(foundationPrompt, /## Teach-Back Gate/);

const index = readFileSync(join(muonDir, "index.ts"), "utf8");
assert.match(index, /registerMuonCommands/);
assert.match(index, /discoverMuonResources/);
assert.match(index, /before_agent_start/);
assert.match(index, /engineeringPrompt/);
assert.match(index, /foundationPrompt/);

const constants = readFileSync(join(muonDir, "constants.ts"), "utf8");
assert.match(constants, /MUON_ENGINEERING_SKILLS_DIR/);
assert.match(constants, /MUON_FOUNDATION_SKILLS_DIR/);
assert.match(constants, /MUON_AUTHORING_SKILLS_DIR/);
assert.doesNotMatch(constants, /MUON_ROUTER_SKILLS_DIR|MUON_SUPERPOWERS_SKILLS_DIR/);

const types = readFileSync(join(muonDir, "types.ts"), "utf8");
assert.match(types, /MuonMode = "off" \| "engineering" \| "foundation"/);
assert.match(types, /mode: MuonMode/);
assert.doesNotMatch(types, /MuonSkillset|skillset:/);

const state = readFileSync(join(muonDir, "state.ts"), "utf8");
assert.match(state, /mode: "off"/);
assert.match(state, /enabledSkills: \["ponytail", "cindex", "handoff"\]/);
assert.match(state, /restoreConfigFromEntries/);
assert.match(state, /normalizeModeSkillIds/);

const statePolicy = readFileSync(join(muonDir, "state-policy.js"), "utf8");
assert.match(statePolicy, /foundation-mode-state/);
assert.match(statePolicy, /superpowersMode/); // restore-only migration

const resources = readFileSync(join(muonDir, "resources.ts"), "utf8");
assert.match(resources, /discoverMuonResources/);
assert.match(resources, /resolveEnabledSkillPaths/);

const skills = readFileSync(join(muonDir, "skills.ts"), "utf8");
assert.match(skills, /id: "engineering"/);
assert.match(skills, /id: "foundation"/);
assert.match(skills, /id: "authoring-skills"/);
assert.match(skills, /normalizeModeSkillIds/);
assert.match(skills, /selectModeSkillIds/);
assert.doesNotMatch(skills, /id: "superpowers"|using-muon/);

const parser = readFileSync(join(muonDir, "command-parser.js"), "utf8");
assert.match(parser, /verb === "mode"/);
assert.match(parser, /rest\.length/);

const commands = readFileSync(join(muonDir, "commands.ts"), "utf8");
assert.match(commands, /showMuonModePicker/);
assert.match(commands, /Mode/);
assert.match(commands, /engineering/);
assert.match(commands, /foundation/);
assert.doesNotMatch(commands, /auto\|ponytail\|superpowers|isMuonSkillset|legacy skillset/);

const readme = readFileSync(join(muonDir, "README.md"), "utf8");
assert.match(readme, /\/muon mode off/);
assert.match(readme, /\/muon mode engineering/);
assert.match(readme, /\/muon mode foundation/);
assert.match(readme, /Minimal/);
assert.match(readme, /authoring-skills/);
assert.doesNotMatch(readme, /using-muon|skillsets\/superpowers/);

console.log("muon mode and skill smoke checks passed");
