import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const telescopeDir = resolve(new URL("..", import.meta.url).pathname);
const index = readFileSync(resolve(telescopeDir, "index.ts"), "utf8");
const liveSkills = readFileSync(resolve(telescopeDir, "providers/skills.ts"), "utf8");
const muonSkills = readFileSync(resolve(telescopeDir, "providers/muon-skills.ts"), "utf8");

test("live skills come from Pi's current skill commands", () => {
	assert.match(index, /"skills":\s+\(_ctx, pi\) => createSkillsProvider\(pi\)/);
	assert.match(liveSkills, /pi\.getCommands\(\)/);
	assert.match(liveSkills, /command\.source === "skill"/);
});

test("Muon skill library attaches a one-shot skill block", () => {
	assert.match(index, /"muon-skills":\s+\(\) => createMuonSkillsProvider\(\)/);
	assert.match(index, /"muon-skills": \["ctrl\+alt\+d"\]/);
	assert.match(muonSkills, /"muon",\s*\n\s*"skillsets"/);
	assert.match(muonSkills, /<skill name=/);
	assert.match(muonSkills, /ctx\.ui\.pasteToEditor/);
});
