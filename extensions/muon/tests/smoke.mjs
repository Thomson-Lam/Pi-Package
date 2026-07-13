import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(new URL("../../..", import.meta.url).pathname);
const muonDir = join(root, "extensions", "muon");

const requiredFiles = [
  "index.ts",
  "constants.ts",
  "types.ts",
  "state.ts",
  "superpowers.ts",
  "skills.ts",
  "commands.ts",
  "skill-dump.ts",
  "README.md",
];

for (const file of requiredFiles) {
  assert.equal(existsSync(join(muonDir, file)), true, `missing ${file}`);
}

const skillsetsDir = join(muonDir, "skillsets");
assert.equal(existsSync(join(skillsetsDir, "muon", "using-muon", "SKILL.md")), true, "missing using-muon skill");
assert.equal(existsSync(join(skillsetsDir, "ponytail", "ponytail", "SKILL.md")), true, "missing ponytail skill");
assert.equal(existsSync(join(skillsetsDir, "ponytail", "ponytail-review", "SKILL.md")), true, "missing ponytail-review skill");
assert.equal(existsSync(join(skillsetsDir, "superpowers", "using-superpowers", "SKILL.md")), true, "missing moved using-superpowers skill");
assert.equal(existsSync(join(skillsetsDir, "superpowers", "writing-plans", "SKILL.md")), true, "missing moved writing-plans skill");
assert.equal(existsSync(join(muonDir, "skills")), false, "stale extensions/muon/skills directory should be removed");
assert.equal(existsSync(join(root, "skills")), false, "top-level skills directory should not contain stray standalone skills");
assert.equal(existsSync(join(root, "extensions", "handoff", "skills")), false, "handoff extension should not contain stray standalone skills");
assert.equal(existsSync(join(skillsetsDir, "standalone", "cindex", "SKILL.md")), true, "missing standalone cindex skill under Muon");
assert.equal(existsSync(join(skillsetsDir, "standalone", "handoff", "SKILL.md")), true, "missing standalone handoff skill under Muon");
assert.equal(existsSync(join(skillsetsDir, "standalone", "ipynb_toolshed", "SKILL.md")), true, "missing standalone ipynb_toolshed skill under Muon");
assert.equal(existsSync(join(skillsetsDir, "standalone", "yagni-scope-guard", "SKILL.md")), true, "missing standalone yagni-scope-guard skill under Muon");

const usingMuon = readFileSync(join(skillsetsDir, "muon", "using-muon", "SKILL.md"), "utf8");
assert.match(usingMuon, /name: using-muon/);
assert.match(usingMuon, /visible means available, not mandatory/);
assert.match(usingMuon, /Large, ambiguous, risky, or multi-step task/);

const scopeGuard = readFileSync(join(skillsetsDir, "standalone", "yagni-scope-guard", "SKILL.md"), "utf8");
assert.match(scopeGuard, /name: yagni-scope-guard/);
assert.match(scopeGuard, /scope-creep/);

const routedSuperpowers = readFileSync(join(skillsetsDir, "superpowers", "using-superpowers", "SKILL.md"), "utf8");
assert.match(routedSuperpowers, /Use when Superpowers workflow or skills are needed/);
assert.doesNotMatch(routedSuperpowers.split("---")[1], /starting any conversation/);

const index = readFileSync(join(muonDir, "index.ts"), "utf8");
assert.match(index, /export default async function muonExtension/);
assert.match(index, /registerMuonCommands/);
assert.match(index, /discoverSuperpowersResources/);

const constants = readFileSync(join(muonDir, "constants.ts"), "utf8");
assert.match(constants, /MUON_EXTENSION_NAME/);
assert.match(constants, /MUON_SKILLSETS_DIR/);
assert.match(constants, /MUON_ROUTER_SKILLS_DIR/);
assert.match(constants, /MUON_PONYTAIL_SKILLS_DIR/);
assert.match(constants, /MUON_SUPERPOWERS_SKILLS_DIR/);
assert.match(constants, /MUON_CINDEX_SKILL_DIR/);
assert.match(constants, /MUON_IPYNB_TOOLS_SHED_SKILL_DIR/);
assert.match(constants, /MUON_HANDOFF_SKILL_DIR/);
assert.match(constants, /MUON_YAGNI_SCOPE_GUARD_SKILL_DIR/);
assert.match(constants, /join\(MUON_SKILLSETS_DIR, "superpowers"\)/);
assert.doesNotMatch(constants, /MUON_SKILLS_DIR/);

const types = readFileSync(join(muonDir, "types.ts"), "utf8");
assert.match(types, /export type MuonSkillset = "off" \| "auto" \| "ponytail" \| "superpowers"/);
assert.match(types, /export type MuonSkillId/);
assert.match(types, /skillset: MuonSkillset/);
assert.match(types, /enabledSkills: MuonSkillId\[\]/);
assert.doesNotMatch(types, /SuperpowersMode/);

const state = readFileSync(join(muonDir, "state.ts"), "utf8");
assert.match(state, /skillset: "off"/);
assert.match(state, /enabledSkills: \[\]/);
assert.match(state, /superpowersMode/); // backward-compatible restore only
assert.match(state, /state\.config\.enabledSkills/);

const superpowers = readFileSync(join(muonDir, "superpowers.ts"), "utf8");
assert.match(superpowers, /discoverSuperpowersResources/);
assert.match(superpowers, /getSkillsetPaths/);
assert.match(superpowers, /resolveEnabledSkillPaths/);
assert.match(superpowers, /skillsetToSkillIds/);
assert.doesNotMatch(superpowers, /MUON_SKILLS_DIR/);

const skills = readFileSync(join(muonDir, "skills.ts"), "utf8");
assert.match(skills, /MUON_SKILL_SOURCES/);
assert.match(skills, /ipynb-toolshed/);
assert.match(skills, /yagni-scope-guard/);
assert.doesNotMatch(skills, /pi-interactive-shell/);
assert.doesNotMatch(skills, /omarchy/);
assert.match(skills, /resolveEnabledSkillPaths/);

const commands = readFileSync(join(muonDir, "commands.ts"), "utf8");
assert.match(commands, /muon/);
assert.match(commands, /Usage: \/muon \[status\|skills\|skill-dump\|help\]/);
assert.match(commands, /skill-dump/);
assert.match(commands, /verb === "skills"/);
assert.doesNotMatch(commands, /verb === "agents"/);
assert.doesNotMatch(commands, /kind: "rollback"/);
assert.match(commands, /function isMuonSkillset/);
assert.match(commands, /showMuonSkillsToggle/);
assert.match(commands, /SettingsList/);
assert.match(commands, /ensureSkillMutationAllowed/);
assert.match(commands, /getExternalSkillCommands/);
assert.match(commands, /\(external\)/);
assert.match(commands, /Ponytail/);
assert.match(commands, /Superpowers/);
assert.match(commands, /state\.config\.enabledSkills/);
assert.doesNotMatch(commands, /state\.config\.superpowersMode/);
assert.doesNotMatch(commands, /isSuperpowersMode/);

const skillDump = readFileSync(join(muonDir, "skill-dump.ts"), "utf8");
assert.match(skillDump, /dumpMuonSkills/);
assert.match(skillDump, /\.agents/);
assert.match(skillDump, /\.claude/);
assert.match(skillDump, /\.codex/);

const readme = readFileSync(join(muonDir, "README.md"), "utf8");
assert.match(readme, /Skills/);
assert.match(readme, /skillsets\/superpowers/);
assert.match(readme, /off/);
assert.match(readme, /auto/);
assert.match(readme, /ponytail/);
assert.match(readme, /superpowers/);
assert.doesNotMatch(readme, /Rollback/);
assert.match(readme, /\/muon skills/);
assert.match(readme, /\/muon skill-dump/);

console.log("muon skills smoke checks passed");
