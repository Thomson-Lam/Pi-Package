import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./helpers.mjs";

const {
  DEFAULT_MODEL_ID,
  DEFAULT_MODEL_PROVIDER,
  orderModels,
  selectModelAndThinking,
} = await load("../src/ui/model-thinking-selector.ts");

test("orderModels puts gpt-5.6-sol first and sorts the remainder", () => {
  const models = [
    { provider: "z-provider", id: "z-model" },
    { provider: DEFAULT_MODEL_PROVIDER, id: DEFAULT_MODEL_ID },
    { provider: "a-provider", id: "a-model" },
  ];

  assert.deepEqual(
    orderModels(models).map((model) => `${model.provider}/${model.id}`),
    [
      `${DEFAULT_MODEL_PROVIDER}/${DEFAULT_MODEL_ID}`,
      "a-provider/a-model",
      "z-provider/z-model",
    ],
  );
  assert.equal(models[0].provider, "z-provider", "sorting must not mutate the registry array");
});

test("selector defaults to gpt-5.6-sol with medium thinking", async () => {
  const models = orderModels([
    { provider: "other", id: "other-model", name: "Other", reasoning: false, contextWindow: 100_000 },
    { provider: DEFAULT_MODEL_PROVIDER, id: DEFAULT_MODEL_ID, name: "SOL", reasoning: true, contextWindow: 200_000 },
  ]);
  const ctx = {
    ui: {
      custom(factory) {
        return new Promise((resolve) => {
          const keybindings = {
            matches(data, action) {
              return action === "tui.select.confirm" && data === "\r";
            },
          };
          const component = factory({ requestRender() {} }, { fg: (_color, text) => text, bold: (text) => text }, keybindings, resolve);
          component.handleInput("\r");
        });
      },
    },
  };

  const result = await selectModelAndThinking(ctx, models, 100_000);
  assert.equal(result.model.provider, DEFAULT_MODEL_PROVIDER);
  assert.equal(result.model.id, DEFAULT_MODEL_ID);
  assert.equal(result.thinkingLevel, "medium");
});
