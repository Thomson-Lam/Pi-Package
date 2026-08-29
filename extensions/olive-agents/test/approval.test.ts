import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { approveInvocation } from "../src/approval.js";

const model = { provider: "test", id: "basic", name: "Basic", reasoning: false } as unknown as Model<Api>;
const registry = { getAll: () => [model], getAvailable: () => [model] };
const request = {
  agentType: "Review", description: "Inspect code", prompt: "task", model,
  thinking: "off" as const, runInBackground: false,
};

function ctx(selection: string) {
  return { mode: "tui", ui: { select: async () => selection } } as unknown as ExtensionContext;
}

describe("subagent approval", () => {
  it("describes a fresh replacement prompt and parent runtime", async () => {
    let title = "";
    await approveInvocation({
      mode: "tui",
      ui: { select: async (value: string) => { title = value; return "Cancel"; } },
    } as unknown as ExtensionContext, registry, request);
    expect(title).toContain("fresh child task only");
    expect(title).toContain("parent working directory");
  });

  it("launches the reviewed task without context fields", async () => {
    await expect(approveInvocation(ctx("Launch"), registry, request)).resolves.toEqual({
      outcome: "launch", prompt: "task", model, thinking: "off",
    });
  });
});
