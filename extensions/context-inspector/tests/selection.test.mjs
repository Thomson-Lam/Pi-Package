import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./helpers.mjs";

const { buildSelectionRequest, parseSelectionOutput, SelectionValidationError } = await load("../src/fresh/selection.ts");
const candidates = new Set(["src/a.ts", "src/b.ts"]);

test("strict selection accepts candidate-only JSON", () => {
  assert.deepEqual(parseSelectionOutput('{"version":1,"paths":["src/a.ts"]}', candidates, 2), { version: 1, paths: ["src/a.ts"] });
});

for (const [name, value] of [
  ["fenced JSON", '```json\n{"version":1,"paths":["src/a.ts"]}\n```'],
  ["empty selection", '{"version":1,"paths":[]}'],
  ["unknown path", '{"version":1,"paths":["src/c.ts"]}'],
  ["duplicate path", '{"version":1,"paths":["src/a.ts","src/a.ts"]}'],
  ["extra property", '{"version":1,"paths":["src/a.ts"],"why":"x"}'],
  ["wrong version", '{"version":2,"paths":["src/a.ts"]}'],
]) {
  test(`strict selection rejects ${name}`, () => {
    assert.throws(() => parseSelectionOutput(value, candidates, 2), SelectionValidationError);
  });
}

test("selection request contains paths but no read contents", () => {
  const request = buildSelectionRequest({ version: 1, projectRoot: "/project", candidates: [{ path: "src/a.ts", absolutePath: "/project/src/a.ts" }] });
  const text = request.content[0].text;
  assert.match(text, /src\/a\.ts/);
  assert.doesNotMatch(text, /absolutePath|\/project\/src/);
});
