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
  "agents.ts",
  "runner.ts",
  "subagent-skills.ts",
  "ledger.ts",
  "worktree.ts",
  "workflow.ts",
  "tools.ts",
  "commands.ts",
  "skill-dump.ts",
  "render.ts",
  "README.md"
];

for (const file of requiredFiles) {
  assert.equal(existsSync(join(muonDir, file)), true, `missing ${file}`);
}

const skillsetsDir = join(muonDir, "skillsets");
assert.equal(
  existsSync(join(skillsetsDir, "muon", "using-muon", "SKILL.md")),
  true,
  "missing using-muon skill"
);
assert.equal(
  existsSync(join(skillsetsDir, "muon", "yagni-scope-guard", "SKILL.md")),
  true,
  "missing yagni-scope-guard skill"
);
assert.equal(
  existsSync(join(skillsetsDir, "ponytail", "ponytail", "SKILL.md")),
  true,
  "missing ponytail skill"
);
assert.equal(
  existsSync(join(skillsetsDir, "ponytail", "ponytail-review", "SKILL.md")),
  true,
  "missing ponytail-review skill"
);
assert.equal(
  existsSync(join(skillsetsDir, "superpowers", "using-superpowers", "SKILL.md")),
  true,
  "missing moved using-superpowers skill"
);
assert.equal(
  existsSync(join(skillsetsDir, "superpowers", "writing-plans", "SKILL.md")),
  true,
  "missing moved writing-plans skill"
);
assert.equal(existsSync(join(muonDir, "skills")), false, "stale extensions/muon/skills directory should be removed");

const usingMuon = readFileSync(
  join(skillsetsDir, "muon", "using-muon", "SKILL.md"),
  "utf8"
);
assert.match(usingMuon, /name: using-muon/);
assert.match(usingMuon, /Catalog visibility means a skill is available/);
assert.match(
  usingMuon,
  /Large, ambiguous, risky, or multi-step implementation/
);

const scopeGuard = readFileSync(
  join(skillsetsDir, "muon", "yagni-scope-guard", "SKILL.md"),
  "utf8"
);
assert.match(scopeGuard, /name: yagni-scope-guard/);
assert.match(scopeGuard, /scope-creep/);

const routedSuperpowers = readFileSync(
  join(skillsetsDir, "superpowers", "using-superpowers", "SKILL.md"),
  "utf8"
);
assert.match(
  routedSuperpowers,
  /Use when Superpowers workflow or skills are needed/
);
assert.doesNotMatch(
  routedSuperpowers.split("---")[1],
  /starting any conversation/
);

const index = readFileSync(join(muonDir, "index.ts"), "utf8");
assert.match(index, /export default async function muonExtension/);
assert.match(index, /registerMuonCommands/);
assert.match(index, /registerMuonTools/);
assert.match(index, /discoverSuperpowersResources/);

const constants = readFileSync(join(muonDir, "constants.ts"), "utf8");
assert.match(constants, /MUON_EXTENSION_NAME/);
assert.match(constants, /MAX_PARALLEL_HARD_CAP = 8/);
assert.match(constants, /MUON_SKILLSETS_DIR/);
assert.match(constants, /MUON_ROUTER_SKILLS_DIR/);
assert.match(constants, /MUON_PONYTAIL_SKILLS_DIR/);
assert.match(constants, /MUON_SUPERPOWERS_SKILLS_DIR/);
assert.match(constants, /MUON_CINDEX_SKILL_DIR/);
assert.match(constants, /MUON_IPYNB_TOOLS_SHED_SKILL_DIR/);
assert.match(constants, /MUON_HANDOFF_SKILL_DIR/);
assert.match(constants, /join\(MUON_SKILLSETS_DIR, "superpowers"\)/);
assert.doesNotMatch(constants, /MUON_SKILLS_DIR/);

const types = readFileSync(join(muonDir, "types.ts"), "utf8");
assert.match(
  types,
  /export type MuonSkillset = "off" \| "auto" \| "ponytail" \| "superpowers"/
);
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
assert.doesNotMatch(skills, /pi-interactive-shell/);
assert.doesNotMatch(skills, /omarchy/);
assert.match(skills, /resolveEnabledSkillPaths/);

const commands = readFileSync(join(muonDir, "commands.ts"), "utf8");
assert.match(commands, /muon/);
assert.match(commands, /Usage: \/muon \[status\|skills\|skill-dump\|help\]/);
assert.match(commands, /skill-dump/);
assert.match(commands, /verb === "skills"/);
assert.doesNotMatch(commands, /verb === "agents"/);
assert.doesNotMatch(commands, /verb === "subagent"/);
assert.doesNotMatch(commands, /verb === "workflow"/);
assert.doesNotMatch(commands, /kind: "rollback"/);

const skillDump = readFileSync(join(muonDir, "skill-dump.ts"), "utf8");
assert.match(skillDump, /dumpMuonSkills/);
assert.match(skillDump, /\.agents/);
assert.match(skillDump, /\.claude/);
assert.match(skillDump, /\.codex/);
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

const agents = readFileSync(join(muonDir, "agents.ts"), "utf8");
assert.match(agents, /discoverMuonAgents/);
assert.match(agents, /findNearestProjectAgentsDir/);
assert.match(agents, /parseFrontmatter/);
assert.match(agents, /skills\?: string\[\]/);
assert.match(agents, /frontmatter\.skills/);

const ledger = readFileSync(join(muonDir, "ledger.ts"), "utf8");
assert.match(ledger, /createRunLedger/);
assert.match(ledger, /appendLedgerEvent/);
assert.match(ledger, /ledger\.md/);
assert.match(ledger, /workflow\.json/);

const runner = readFileSync(join(muonDir, "runner.ts"), "utf8");
assert.match(runner, /spawn/);
assert.match(runner, /--mode/);
assert.match(runner, /json/);
assert.match(runner, /MUON_DEPTH/);
assert.match(runner, /runSingleMuonAgent/);
assert.match(runner, /runMuonAgentsParallel/);
assert.match(runner, /runMuonAgentChain/);
assert.match(runner, /--no-skills/);
assert.match(runner, /--skill/);
assert.match(runner, /resolveMuonSubagentSkill/);

const tools = readFileSync(join(muonDir, "tools.ts"), "utf8");
assert.match(tools, /muon_subagent/);
assert.match(tools, /muon_workflow/);
assert.match(tools, /StringEnum/);
assert.match(tools, /confirmProjectAgents/);

const render = readFileSync(join(muonDir, "render.ts"), "utf8");
assert.match(render, /renderMuonSubagentResult/);

const workflow = readFileSync(join(muonDir, "workflow.ts"), "utf8");
assert.match(workflow, /runMuonWorkflow/);
assert.match(workflow, /phases/);
assert.match(workflow, /single/);
assert.match(workflow, /parallel/);
assert.match(workflow, /chain/);

const worktree = readFileSync(join(muonDir, "worktree.ts"), "utf8");
assert.match(worktree, /prepareMuonWorktree/);
assert.match(worktree, /checkpointMuonWorktree/);
assert.match(worktree, /rollbackMuonWorktree/);
assert.match(worktree, /git worktree/);

const subagentSkills = readFileSync(join(muonDir, "subagent-skills.ts"), "utf8");
assert.match(subagentSkills, /resolveMuonSubagentSkill/);
assert.match(subagentSkills, /ponytail/);
assert.match(subagentSkills, /MUON_PONYTAIL_SKILLS_DIR/);

const readme = readFileSync(join(muonDir, "README.md"), "utf8");
assert.match(readme, /Skills/);
assert.match(readme, /skillsets\/superpowers/);
assert.match(readme, /off/);
assert.match(readme, /auto/);
assert.match(readme, /ponytail/);
assert.match(readme, /superpowers/);
assert.doesNotMatch(readme, /muon_subagent/);
assert.doesNotMatch(readme, /muon_workflow/);
assert.doesNotMatch(readme, /Rollback/);
assert.match(readme, /\/muon skills/);
assert.match(readme, /\/muon skill-dump/);

console.log("muon skills smoke checks passed");
