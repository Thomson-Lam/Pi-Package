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
  "agents.ts",
  "runner.ts",
  "ledger.ts",
  "worktree.ts",
  "workflow.ts",
  "tools.ts",
  "commands.ts",
  "render.ts",
  "README.md",
];

for (const file of requiredFiles) {
  assert.equal(existsSync(join(muonDir, file)), true, `missing ${file}`);
}

const index = readFileSync(join(muonDir, "index.ts"), "utf8");
assert.match(index, /export default async function muonExtension/);
assert.match(index, /registerMuonCommands/);
assert.match(index, /registerMuonTools/);

const constants = readFileSync(join(muonDir, "constants.ts"), "utf8");
assert.match(constants, /MUON_EXTENSION_NAME/);
assert.match(constants, /MAX_PARALLEL_HARD_CAP = 8/);
assert.match(constants, /MUON_SKILLS_DIR/);

assert.equal(existsSync(join(muonDir, "skills", "using-superpowers", "SKILL.md")), true, "missing bundled using-superpowers skill");
assert.equal(existsSync(join(muonDir, "skills", "writing-plans", "SKILL.md")), true, "missing bundled writing-plans skill");

const superpowers = readFileSync(join(muonDir, "superpowers.ts"), "utf8");
assert.match(superpowers, /discoverSuperpowersResources/);
assert.match(superpowers, /maybeInjectSuperpowersBootstrap/);
assert.match(superpowers, /using-superpowers/);
assert.match(superpowers, /stripFrontmatter/);

const commands = readFileSync(join(muonDir, "commands.ts"), "utf8");
assert.match(commands, /muon/);
assert.match(commands, /skills/);
assert.match(commands, /on\|off/);
assert.match(commands, /pickMuonSkillsAction/);
assert.match(commands, /Muon Skills/);
const skillsPicker = commands.match(/async function pickMuonSkillsAction[\s\S]*?async function showMuonHelp/)?.[0] ?? "";
assert.match(skillsPicker, /value: "on"/);
assert.match(skillsPicker, /value: "off"/);
assert.doesNotMatch(skillsPicker, /value: "status"/);
assert.doesNotMatch(skillsPicker, /value: "help"/);
assert.doesNotMatch(commands, /skills off\|discover\|bootstrap/);
assert.doesNotMatch(commands, /skills on\|off\|discover\|bootstrap/);

const agents = readFileSync(join(muonDir, "agents.ts"), "utf8");
assert.match(agents, /discoverMuonAgents/);
assert.match(agents, /findNearestProjectAgentsDir/);
assert.match(agents, /parseFrontmatter/);

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

const tools = readFileSync(join(muonDir, "tools.ts"), "utf8");
assert.match(tools, /muon_subagent/);
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

const toolsAfterWorkflow = readFileSync(join(muonDir, "tools.ts"), "utf8");
assert.match(toolsAfterWorkflow, /muon_workflow/);

const worktree = readFileSync(join(muonDir, "worktree.ts"), "utf8");
assert.match(worktree, /prepareMuonWorktree/);
assert.match(worktree, /checkpointMuonWorktree/);
assert.match(worktree, /rollbackMuonWorktree/);
assert.match(worktree, /git worktree/);

const commandsAfterRuns = readFileSync(join(muonDir, "commands.ts"), "utf8");
assert.match(commandsAfterRuns, /runs/);
assert.match(commandsAfterRuns, /open/);

const indexAfterRender = readFileSync(join(muonDir, "index.ts"), "utf8");
assert.match(indexAfterRender, /renderMuonSubagentResult/);

const readme = readFileSync(join(muonDir, "README.md"), "utf8");
assert.match(readme, /Skills mode/);
assert.match(readme, /Bundled skills/);
assert.match(readme, /muon_subagent/);
assert.match(readme, /muon_workflow/);
assert.match(readme, /Rollback/);

console.log("muon scaffold smoke checks passed");
