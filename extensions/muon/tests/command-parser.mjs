import assert from "node:assert/strict";
import { parseMuonAction } from "../command-parser.js";

const skillIds = ["ponytail", "authoring-skills", "cindex", "yagni-product-design"];
const parse = (input) => parseMuonAction(input, skillIds);

assert.deepEqual(parse(""), { kind: "menu" });
assert.deepEqual(parse("mode"), { kind: "action", action: { kind: "mode" } });
assert.deepEqual(parse("build"), { kind: "action", action: { kind: "mode", mode: "build" } });
assert.deepEqual(parse("spec"), { kind: "action", action: { kind: "mode", mode: "spec" } });
assert.deepEqual(parse("off"), { kind: "action", action: { kind: "mode", mode: "off" } });
assert.deepEqual(parse("skills off cindex"), { kind: "action", action: { kind: "skills", op: "off", skillId: "cindex" } });
assert.deepEqual(parse("skills off"), { kind: "action", action: { kind: "skills", op: "profile", profile: "off" } });
assert.deepEqual(parse("skill-dump pi"), { kind: "action", action: { kind: "skill-dump", target: "pi" } });

for (const invalid of [
  "status junk",
  "mode status",
  "mode build",
  "mode off",
  "build junk",
  "spec junk",
  "off junk",
  "mode engineering",
  "skills engineering",
  "mode foundation",
  "skills foundation",
  "skills on cindex junk",
  "skills status junk",
  "skill-dump pi junk",
  "skills on unknown",
  "mode unknown",
]) {
  assert.equal(parse(invalid).kind, "error", `${invalid} should be rejected`);
}

console.log("muon command parser checks passed");
