import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./helpers.mjs";

const { buildSelectionRequest, formatLedgerMarkdown, parseSelectionResponse, validateSelection, SelectionValidationError } = await load("../src/fresh/selection.ts");
const ledger = {
  version: 1,
  projectRoot: "/project",
  candidates: [
    { path: "src/a.ts", absolutePath: "/project/src/a.ts" },
    { path: "src/b.ts", absolutePath: "/project/src/b.ts" },
  ],
};

test("parses agent selection block", () => {
  const response = `<fresh-context-selection>\npaths:\n- src/a.ts\nsuggestedPaths:\n- src/c.ts\n</fresh-context-selection>`;
  assert.deepEqual(parseSelectionResponse(response, ledger, 3).selectedPaths, ["src/a.ts", "src/c.ts"]);
});

test("strict selection accepts ledger paths and project-local suggestions", () => {
  assert.deepEqual(validateSelection({ paths: ["src/a.ts"], suggestedPaths: ["src/c.ts"] }, ledger, 3), {
    selectedPaths: ["src/a.ts", "src/c.ts"],
    ledger: {
      ...ledger,
      candidates: [...ledger.candidates, { path: "src/c.ts", absolutePath: "/project/src/c.ts" }],
    },
    suggestedPaths: ["src/c.ts"],
  });
});

test("paths entries outside the ledger are downgraded to fresh-read suggestions", () => {
  assert.deepEqual(validateSelection({ paths: ["src/c.ts"] }, ledger, 3), {
    selectedPaths: ["src/c.ts"],
    ledger: {
      ...ledger,
      candidates: [...ledger.candidates, { path: "src/c.ts", absolutePath: "/project/src/c.ts" }],
    },
    suggestedPaths: ["src/c.ts"],
  });
});

for (const [name, value] of [
  ["non-object arguments", "invalid"],
  ["empty selection", { paths: [] }],
  ["outside project path", { paths: ["../outside.ts"] }],
  ["duplicate path", { paths: ["src/a.ts"], suggestedPaths: ["src/a.ts"] }],
  ["extra property", { paths: ["src/a.ts"], why: "x" }],
  ["outside project suggestion", { paths: ["src/a.ts"], suggestedPaths: ["../outside.ts"] }],
]) {
  test(`strict selection rejects ${name}`, () => {
    assert.throws(() => validateSelection(value, ledger, 2), SelectionValidationError);
  });
}

test("selection request renders the ledger as markdown without absolute paths or JSON version fields", () => {
  const text = buildSelectionRequest(ledger);
  assert.match(text, /## Previously read files/);
  assert.match(text, /- `src\/a\.ts`/);
  assert.doesNotMatch(text, /absolutePath|\/project\/src|"version"|Candidate read ledger/);
});

test("formatLedgerMarkdown uses bullet paths only", () => {
  assert.equal(formatLedgerMarkdown({ version: 1, projectRoot: "/project", candidates: [{ path: "src/a.ts", absolutePath: "/project/src/a.ts" }] }), "- `src/a.ts`");
});
