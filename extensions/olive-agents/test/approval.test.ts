import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { approveInvocation, availableThinkingLevels } from "../src/approval.js";

const models = [
  { provider: "test", id: "basic", name: "Basic", reasoning: false },
  { provider: "test", id: "reasoning", name: "Reasoning", reasoning: true },
] as unknown as Model<Api>[];
const registry = { find: () => undefined, getAll: () => models, getAvailable: () => models };
const request = { agentType: "Explore", description: "Inspect code", prompt: "task", model: models[0], thinking: "off" as const, runInBackground: false, inheritContext: false, isolated: false, promptMode: "replace" as const };

function ctx(selections: string[], editor = "edited") {
  return { mode: "tui", ui: { select: async () => selections.shift(), editor: async () => editor } } as unknown as ExtensionContext;
}

describe("subagent approval", () => {
  it("launches the edited task", async () => {
    const result = await approveInvocation(ctx(["Edit child task", "Launch"]), registry, request);
    expect(result).toMatchObject({ outcome: "launch", prompt: "edited" });
    expect(availableThinkingLevels(models[0])).toEqual(["off"]);
  });
  it("returns feedback distinctly", async () => {
    expect(await approveInvocation(ctx(["Feedback to main agent"], "change course"), registry, request))
      .toEqual({ outcome: "feedback", feedback: "change course" });
  });
  it("returns do-it-yourself distinctly", async () => {
    expect(await approveInvocation(ctx(["Do it yourself"]), registry, request))
      .toEqual({ outcome: "do-it-yourself", prompt: "task" });
  });
  it("keeps cancellation neutral and fails closed outside TUI", async () => {
    expect(await approveInvocation(ctx(["Cancel"]), registry, request)).toEqual({ outcome: "cancel" });
    expect(await approveInvocation({ mode: "print" } as ExtensionContext, registry, request)).toEqual({ outcome: "cancel" });
  });
});
