import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { approveInvocation, availableThinkingLevels } from "../src/approval.js";

const models = [
  { provider: "test", id: "basic", name: "Basic", reasoning: false },
  { provider: "test", id: "reasoning", name: "Reasoning", reasoning: true },
] as unknown as Model<Api>[];

const registry = {
  find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
  getAll: () => models,
  getAvailable: () => models,
};

describe("subagent approval", () => {
  it("revalidates edited prompt, model, and reasoning before approval", async () => {
    const selections = [
      "Edit task prompt",
      "Change model (test/basic)",
      "test/reasoning",
      "Change reasoning (off)",
      "high",
      "Approve and launch",
    ];
    const summaries: string[] = [];
    const ctx = {
      mode: "tui",
      ui: {
        select: async (title: string) => {
          summaries.push(title);
          return selections.shift();
        },
        editor: async () => "edited task",
      },
    } as unknown as ExtensionContext;

    const result = await approveInvocation(ctx, registry, {
      agentType: "Explore",
      description: "Inspect code",
      prompt: "original task",
      model: models[0],
      thinking: "off",
      runInBackground: false,
      inheritContext: false,
      isolated: false,
      promptMode: "replace",
    });

    expect(result).toMatchObject({ prompt: "edited task", model: models[1], thinking: "high" });
    expect(summaries.at(-1)).toContain("Task prompt:\nedited task");
    expect(availableThinkingLevels(models[0])).toEqual(["off"]);
  });

  it("fails closed without the interactive TUI", async () => {
    const result = await approveInvocation({ mode: "print" } as unknown as ExtensionContext, registry, {
      agentType: "Explore",
      description: "Inspect code",
      prompt: "task",
      model: models[0],
      thinking: "off",
      runInBackground: false,
      inheritContext: false,
      isolated: false,
      promptMode: "replace",
    });

    expect(result).toBeUndefined();
  });
});
