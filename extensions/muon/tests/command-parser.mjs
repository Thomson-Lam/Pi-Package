import assert from "node:assert/strict";
import { parseMuonAction } from "../command-parser.js";

const skillIds = ["ponytail", "engineering", "foundation", "authoring-skills", "cindex", "handoff"];
const parse = (input) => parseMuonAction(input, skillIds);

assert.deepEqual(parse(""), { kind: "menu" });
assert.deepEqual(parse("mode"), { kind: "action", action: { kind: "mode" } });
assert.deepEqual(parse("mode status"), { kind: "action", action: { kind: "mode", status: true } });
assert.deepEqual(parse("mode engineering"), { kind: "action", action: { kind: "mode", mode: "engineering" } });
assert.deepEqual(parse("skills engineering"), { kind: "action", action: { kind: "skills", op: "profile", profile: "engineering" } });
assert.deepEqual(parse("skills off cindex"), { kind: "action", action: { kind: "skills", op: "off", skillId: "cindex" } });
assert.deepEqual(parse("skills off"), { kind: "action", action: { kind: "skills", op: "profile", profile: "off" } });
assert.deepEqual(parse("skill-dump pi"), { kind: "action", action: { kind: "skill-dump", target: "pi" } });

for (const invalid of [
  "status junk",
  "mode engineering junk",
  "skills foundation junk",
  "skills on cindex junk",
  "skills status junk",
  "skill-dump pi junk",
  "skills on unknown",
  "mode unknown",
]) {
  assert.equal(parse(invalid).kind, "error", `${invalid} should be rejected`);
}

console.log("muon command parser checks passed");
