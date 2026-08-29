import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(new URL("../../..", import.meta.url).pathname);
const muonDir = join(root, "extensions", "muon");
const skillsetsDir = join(muonDir, "skillsets");
const modesDir = join(muonDir, "modes");
const foundationArchiveDir = join(muonDir, "archive", "foundation-mode");
const engineeringArchiveDir = join(muonDir, "archive", "engineering-mode");

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
  "modes/build-prompt.md",
  "modes/spec-prompt.md",
]) {
  assert.equal(existsSync(join(muonDir, file)), true, `missing ${file}`);
}

assert.equal(existsSync(join(muonDir, "superpowers.ts")), false, "stale superpowers resource module remains");
assert.equal(existsSync(join(skillsetsDir, "muon", "using-muon", "SKILL.md")), false, "stale using-muon skill remains");
assert.equal(existsSync(join(skillsetsDir, "superpowers")), false, "Superpowers should not remain in Muon's active skillsets");
assert.equal(existsSync(join(root, "extensions", "foundation-mode", "index.ts")), false, "separate Foundation entrypoint remains");
assert.equal(existsSync(join(skillsetsDir, "foundation")), false, "Foundation should not remain in active skillsets");
assert.equal(existsSync(join(modesDir, "foundation-prompt.md")), false, "Foundation prompt should not remain active");
assert.equal(existsSync(join(skillsetsDir, "engineering")), false, "Engineering should not remain in active skillsets");
assert.equal(existsSync(join(modesDir, "engineering-prompt.md")), false, "Engineering prompt should not remain active");
assert.equal(existsSync(join(foundationArchiveDir, "modes", "foundation-prompt.md")), true, "missing archived Foundation prompt");
assert.equal(existsSync(join(engineeringArchiveDir, "modes", "engineering-prompt.md")), true, "missing archived Engineering prompt");
assert.equal(existsSync(join(engineeringArchiveDir, "skillsets", "engineering", "brainstorming", "SKILL.md")), true, "missing archived Engineering skills");
assert.equal(existsSync(join(foundationArchiveDir, "skillsets", "foundation", "caveman", "SKILL.md")), true, "missing archived Caveman skill");
assert.equal(existsSync(join(root, "extensions", "superpowers")), false, "stale Superpowers archive remains");

for (const path of [
  ["ponytail", "ponytail"],
  ["ponytail", "ponytail-review"],
  ["ponytail", "ponytail-debt"],
  ["standalone", "authoring-skills"],
  ["standalone", "cindex"],
  ["standalone", "github-issues-prs"],
  ["standalone", "ipynb_toolshed"],
  ["standalone", "tlogs"],
  ["standalone", "tcmd"],
  ["standalone", "yagni-product-design"],
]) {
  assert.equal(existsSync(join(skillsetsDir, ...path, "SKILL.md")), true, `missing skill ${path.join("/")}`);
}

const tmuxLogsSkillDir = join(skillsetsDir, "standalone", "tlogs");
assert.equal(existsSync(join(tmuxLogsSkillDir, "extension.ts")), true, "missing Muon-governed tmux logs extension");
assert.equal(existsSync(join(tmuxLogsSkillDir, "scripts", "tmux-tdl-logs")), true, "missing tlogs helper");
assert.equal(existsSync(join(root, "extensions", "tmux-tdl-logs")), false, "tlogs should not have a separate extension entrypoint");
const tmuxLogsExtension = readFileSync(join(tmuxLogsSkillDir, "extension.ts"), "utf8");
assert.match(tmuxLogsExtension, /isEnabled/);
assert.match(tmuxLogsExtension, /setActiveTools/);
const tmuxCommandSkillDir = join(skillsetsDir, "standalone", "tcmd");
assert.equal(existsSync(join(tmuxCommandSkillDir, "extension.ts")), true, "missing Muon-governed tmux command extension");
assert.equal(existsSync(join(tmuxCommandSkillDir, "scripts", "tmux-human-command")), true, "missing tcmd helper");
assert.equal(existsSync(join(tmuxCommandSkillDir, "relative-diff.js")), true, "missing tcmd relative diff helper");
const tmuxCommandExtension = readFileSync(join(tmuxCommandSkillDir, "extension.ts"), "utf8");
assert.match(tmuxCommandExtension, /registerCommand\("cmd"/);
assert.doesNotMatch(tmuxCommandExtension, /registerCommand\("cmdone"/);
assert.match(tmuxCommandExtension, /Full-staging/);
assert.match(tmuxCommandExtension, /Give feedback/);
assert.match(tmuxCommandExtension, /observation/);
assert.match(tmuxCommandExtension, /record-stop/);
assert.match(tmuxCommandExtension, /deliverAs: automatic \? "followUp" : "nextTurn"/);
const tmuxCommandScript = readFileSync(join(tmuxCommandSkillDir, "scripts", "tmux-human-command"), "utf8");
assert.match(tmuxCommandScript, /send-keys/);
assert.match(tmuxCommandScript, /stage\|run/);
assert.doesNotMatch(tmuxCommandScript, /record-start|record-stop|record-read|record-remove/);
assert.match(tmuxCommandScript, /send-keys -t \"\$pane\" Enter/);

const githubSkillDir = join(skillsetsDir, "standalone", "github-issues-prs");
assert.equal(existsSync(join(githubSkillDir, "scripts", "github-md")), true, "missing github-md helper");
const githubSkill = readFileSync(join(githubSkillDir, "SKILL.md"), "utf8");
assert.match(githubSkill, /^---\nname: github-issues-prs\n/);
assert.match(githubSkill, /issue-read/);
assert.match(githubSkill, /issue-create/);
assert.match(githubSkill, /pr-create/);

for (const skill of ["ponytail", "ponytail-review", "ponytail-debt"]) {
  const content = readFileSync(join(skillsetsDir, "ponytail", skill, "SKILL.md"), "utf8");
  assert.doesNotMatch(content, /using-muon/, `${skill} still routes through using-muon`);
}

const yagniSkill = readFileSync(join(skillsetsDir, "standalone", "yagni-product-design", "SKILL.md"), "utf8");
assert.match(yagniSkill, /^---\nname: yagni-product-design\n/);
assert.match(yagniSkill, /simplest direct product/);

const buildPrompt = readFileSync(join(modesDir, "build-prompt.md"), "utf8");
const specPrompt = readFileSync(join(modesDir, "spec-prompt.md"), "utf8");
const archivedEngineeringPrompt = readFileSync(join(engineeringArchiveDir, "modes", "engineering-prompt.md"), "utf8");
const archivedFoundationPrompt = readFileSync(join(foundationArchiveDir, "modes", "foundation-prompt.md"), "utf8");
assert.match(buildPrompt, /^Assist the user in turning their structure and idea into systems and code/);
assert.match(buildPrompt, /NOT a planning agent/);
assert.match(specPrompt, /^You are a spec agent/);
assert.match(specPrompt, /Do NOT write detailed project implementation/);
assert.match(archivedEngineeringPrompt, /^You are operating in Muon Engineering Mode/);
assert.match(archivedEngineeringPrompt, /## Skill Invocation Policy/);
assert.match(archivedFoundationPrompt, /^# Foundation Mode/);
assert.match(archivedFoundationPrompt, /## Teach-Back Gate/);

const index = readFileSync(join(muonDir, "index.ts"), "utf8");
assert.match(index, /registerMuonCommands/);
assert.match(index, /registerTlogs/);
assert.match(index, /registerTcmd/);
assert.match(index, /discoverMuonResources/);
assert.match(index, /before_agent_start/);
assert.match(index, /buildPrompt/);
assert.match(index, /specPrompt/);
assert.doesNotMatch(index, /engineering|foundation/i);

const constants = readFileSync(join(muonDir, "constants.ts"), "utf8");
assert.match(constants, /MUON_BUILD_PROMPT_PATH/);
assert.match(constants, /MUON_SPEC_PROMPT_PATH/);
assert.match(constants, /MUON_YAGNI_PRODUCT_DESIGN_SKILL_DIR/);
assert.match(constants, /MUON_AUTHORING_SKILLS_DIR/);
assert.match(constants, /MUON_GITHUB_ISSUES_PRS_SKILL_DIR/);
assert.doesNotMatch(constants, /engineering|foundation/i);
assert.doesNotMatch(constants, /MUON_ROUTER_SKILLS_DIR|MUON_SUPERPOWERS_SKILLS_DIR/);

const types = readFileSync(join(muonDir, "types.ts"), "utf8");
assert.match(types, /MuonMode = "off" \| "build" \| "spec"/);
assert.doesNotMatch(types, /engineering|foundation/i);
assert.match(types, /mode: MuonMode/);
assert.doesNotMatch(types, /MuonSkillset|skillset:/);

const state = readFileSync(join(muonDir, "state.ts"), "utf8");
assert.match(state, /mode: "build"/);
assert.match(state, /enabledSkills: \["ponytail", "cindex", "github-issues-prs", "tlogs", "tcmd"\]/);
assert.match(state, /restoreConfigFromEntries/);
assert.match(state, /normalizeModeSkillIds/);

const statePolicy = readFileSync(join(muonDir, "state-policy.js"), "utf8");
assert.doesNotMatch(statePolicy, /engineering|foundation/i);
assert.match(statePolicy, /superpowersMode/); // restore-only migration

const resources = readFileSync(join(muonDir, "resources.ts"), "utf8");
assert.match(resources, /discoverMuonResources/);
assert.match(resources, /resolveEnabledSkillPaths/);

const skills = readFileSync(join(muonDir, "skills.ts"), "utf8");
assert.match(skills, /id: "authoring-skills"/);
assert.match(skills, /id: "github-issues-prs"/);
assert.match(skills, /id: "yagni-product-design"/);
assert.match(skills, /id: "tcmd"/);
assert.doesNotMatch(skills, /engineering|foundation/i);
assert.match(skills, /normalizeModeSkillIds/);
assert.match(skills, /selectModeSkillIds/);
assert.doesNotMatch(skills, /id: "superpowers"|using-muon/);

const parser = readFileSync(join(muonDir, "command-parser.js"), "utf8");
assert.match(parser, /verb === "mode"/);
assert.match(parser, /rest\.length/);

const commands = readFileSync(join(muonDir, "commands.ts"), "utf8");
assert.match(commands, /registerCommand\("mus"/);
assert.match(commands, /showMuonModePicker/);
assert.match(commands, /\{ value: "skills"[\s\S]*\{ value: "mode"[\s\S]*\{ value: "skill-dump"[\s\S]*\{ value: "status"[\s\S]*\{ value: "help"/);
assert.match(commands, /Mode/);
assert.match(commands, /build/);
assert.match(commands, /spec/);
assert.match(commands, /tcmd/);
assert.doesNotMatch(commands, /engineering|foundation/i);
assert.doesNotMatch(commands, /auto\|ponytail\|superpowers|isMuonSkillset|legacy skillset/);

console.log("muon mode and skill smoke checks passed");
