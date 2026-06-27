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

const superpowers = readFileSync(join(muonDir, "superpowers.ts"), "utf8");
assert.match(superpowers, /discoverSuperpowersResources/);
assert.match(superpowers, /maybeInjectSuperpowersBootstrap/);
assert.match(superpowers, /using-superpowers/);
assert.match(superpowers, /stripFrontmatter/);

const commands = readFileSync(join(muonDir, "commands.ts"), "utf8");
assert.match(commands, /muon/);
assert.match(commands, /skills/);
assert.match(commands, /bootstrap/);

const agents = readFileSync(join(muonDir, "agents.ts"), "utf8");
assert.match(agents, /discoverMuonAgents/);
assert.match(agents, /findNearestProjectAgentsDir/);
assert.match(agents, /parseFrontmatter/);

console.log("muon scaffold smoke checks passed");
