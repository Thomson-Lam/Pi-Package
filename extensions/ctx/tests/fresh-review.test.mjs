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

test("confirming preserves the objective submitted by the review editor", async () => {
  const ctx = {
    ui: {
      custom(factory) {
        return new Promise((resolve) => {
          const component = factory({ requestRender() {} }, theme, {}, resolve);
          for (const character of "Implement the validated fix") component.handleInput(character);
          component.handleInput("\r");
          component.handleInput("\r");
        });
      },
    },
  };

  const result = await reviewFreshTransition(ctx, prepared);
  assert.deepEqual(result, { action: "confirm", objective: "Implement the validated fix" });
});
