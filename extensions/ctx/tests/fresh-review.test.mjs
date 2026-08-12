import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./helpers.mjs";

const { reviewFreshTransition } = await load("../src/ui/fresh-review.ts");

const prepared = {
  selectedPaths: ["src/a.ts"],
  included: [{ path: "src/a.ts", bytes: 7, estimatedTokens: 2 }],
  excluded: [],
  totalBytes: 7,
  estimatedTokens: 2,
};

const theme = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

function contextForInput(input) {
  return {
    ui: {
      custom(factory) {
        return new Promise((resolve) => {
          const component = factory({ requestRender() {} }, theme, {}, resolve);
          for (const character of input) component.handleInput(character);
        });
      },
    },
  };
}

test("objective submission requests a model before final confirmation", async () => {
  const objective = "Implement the validated fix";
  const first = await reviewFreshTransition(contextForInput(`${objective}\r`), prepared);
  assert.deepEqual(first, { action: "select-model", objective });

  const selection = {
    model: { provider: "openai-codex", id: "gpt-5.6-sol" },
    thinkingLevel: "medium",
  };
  const final = await reviewFreshTransition(contextForInput("\r"), prepared, objective, selection);
  assert.deepEqual(final, { action: "confirm", objective });
});
