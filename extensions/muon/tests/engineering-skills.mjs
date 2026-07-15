import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(new URL("../../..", import.meta.url).pathname);
const skillsetsRoot = join(root, "extensions", "muon", "skillsets");

const expected = {
  brainstorming: /unresolved product behavior|unclear success criteria/,
  "planning-risky-changes": /high-risk change/,
  "delegating-work": /subagents|parallel investigation/,
  "choosing-test-strategy": /testing\s+approach is unclear/,
  "systematic-debugging": /bugs, test failures|unexpected runtime results/,
  "verifying-work": /claim implementation is complete|ready to integrate/,
  "reviewing-changes": /evaluating a consequential diff|review feedback/,
  "isolating-work": /risky, long-running|current checkout/,
  "finishing-work": /ready for merge|pull request/,
  "authoring-skills": /creating, revising, or evaluating reusable agent skills/,
};

const additionalTriggers = {
  "planning-risky-changes": /explicitly requested durable plan|handoff|multi-session/,
};

const forbiddenTriggers = {
  "reviewing-changes": /before merging/,
  "verifying-work": /ready to integrate/,
};

const selected = process.argv[2] ? [process.argv[2]] : Object.keys(expected);
for (const name of selected) {
  assert.ok(name in expected, `unknown engineering skill: ${name}`);
  const group = name === "authoring-skills" ? "standalone" : "engineering";
  const path = join(skillsetsRoot, group, name, "SKILL.md");
  assert.equal(existsSync(path), true, `missing engineering skill: ${name}`);

  const content = readFileSync(path, "utf8");
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(frontmatterMatch, `${name}: malformed or unterminated frontmatter`);
  const frontmatter = frontmatterMatch[1];
  assert.match(frontmatter, new RegExp(`^name: ${name}$`, "m"), `${name}: frontmatter name mismatch`);
  assert.match(frontmatter, /^description: >?\n?\s*Use when/m, `${name}: description must start with Use when`);
  assert.match(frontmatter, expected[name], `${name}: description lacks its specific trigger`);
  if (additionalTriggers[name]) {
    assert.match(frontmatter, additionalTriggers[name], `${name}: description lacks a secondary trigger`);
  }
  if (forbiddenTriggers[name]) {
    assert.doesNotMatch(frontmatter, forbiddenTriggers[name], `${name}: description contains an overlapping trigger`);
  }

  const words = content.trim().split(/\s+/).length;
  assert.ok(words <= 650, `${name}: ${words} words exceeds the 650-word limit`);

  assert.doesNotMatch(content, /1% chance|EXTREMELY-IMPORTANT|Iron Law|REQUIRED SUB-SKILL|announce at start|one question per message/i);
  assert.doesNotMatch(content, /invoke every|always invoke|mandatory workflow|follow (?:each step|this process) exactly/i);
}

console.log(`engineering skill checks passed: ${selected.join(", ")}`);
