import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
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

describe("approval with context ledger", () => {
  const branch = [{
    type: "message", id: "e1", parentId: null, timestamp: "2025-01-01T00:00:00.000Z",
    message: { role: "user", content: "hello" },
  }] as never[];
  const candidates = [{
    version: 1, id: "L0", sourceSessionName: "parent agent", createdAt: "2025-01-01T00:00:00.000Z",
    selections: [],
  }];

  /** select answers in order; extra calls fall back to "Launch". */
  function selectQueue(answers: string[]) {
    let i = 0;
    return async () => answers[i++] ?? "Launch";
  }
  /** custom answers in order; a function entry means "run the factory (loader)". */
  function customQueue(answers: unknown[]) {
    let i = 0;
    return async (factory: any) => {
      const next = answers[i++];
      if (typeof next === "function") {
        return new Promise((resolve) => { factory(null, null, null, resolve); });
      }
      return next;
    };
  }

  it("flow: select → inherit Yes (tree) → compact No → launch", async () => {
    const ui = {
      select: selectQueue(["Build context", "Yes", "No"]),
      custom: customQueue([{ selectedIds: ["e1"] }]),
    };
    const openInheritTree = vi.fn(async () => [candidates[0]]);
    const summarize = vi.fn(() => Promise.resolve("summary text"));
    const result = await approveInvocation(
      { mode: "tui", ui } as unknown as ExtensionContext,
      registry,
      request,
      { branch, candidates, summarize, openInheritTree },
    );
    expect(result.outcome).toBe("launch");
    if (result.outcome !== "launch") return;
    expect(result.context).toEqual({
      selectedIds: ["e1"],
      summary: undefined,
      inheritedNodes: [candidates[0]],
    });
    expect(openInheritTree).toHaveBeenCalledWith("L0");
    expect(summarize).not.toHaveBeenCalled();
  });

  it("inherit tree returning an empty chain drops the inherited context", async () => {
    const ui = {
      select: selectQueue(["Build context", "Yes", "No"]),
      custom: customQueue([{ selectedIds: ["e1"] }]),
    };
    const openInheritTree = vi.fn(async () => []);
    const result = await approveInvocation(
      { mode: "tui", ui } as unknown as ExtensionContext,
      registry,
      request,
      { branch, candidates, summarize: () => Promise.resolve("s"), openInheritTree },
    );
    expect(result.outcome).toBe("launch");
    if (result.outcome !== "launch") return;
    expect(result.context?.inheritedNodes).toEqual([]);
    expect(result.context?.summary).toBeUndefined();
  });

  it("no candidates: the inherit question and tree are skipped entirely", async () => {
    const ui = {
      select: selectQueue(["Build context", "No"]), // no inherit select slot
      custom: customQueue([{ selectedIds: ["e1"] }]),
    };
    const openInheritTree = vi.fn(async () => [candidates[0]]);
    const result = await approveInvocation(
      { mode: "tui", ui } as unknown as ExtensionContext,
      registry,
      request,
      { branch, candidates: [], summarize: () => Promise.resolve("s"), openInheritTree },
    );
    expect(result.outcome).toBe("launch");
    if (result.outcome !== "launch") return;
    expect(result.context?.inheritedNodes).toEqual([]);
    expect(openInheritTree).not.toHaveBeenCalled();
  });

  it("compact: Yes summarizes the FULL conversation through the loader surface", async () => {
    // select queue: builder, inherit ? No, compact ? Yes → loader follows.
    const ui = {
      select: selectQueue(["Build context", "No", "Yes"]),
      custom: customQueue([
        { selectedIds: ["e1"] }, // selection TUI
        async (factory: any) => new Promise((resolve) => factory(null, null, null, resolve)), // loader
      ]),
    };
    const openInheritTree = vi.fn(async () => [candidates[0]]);
    const summarize = vi.fn((_b, ids) => Promise.resolve(ids.join(",")));
    const result = await approveInvocation(
      { mode: "tui", ui } as unknown as ExtensionContext,
      registry,
      request,
      { branch, candidates, summarize, openInheritTree },
    );
    expect(openInheritTree).not.toHaveBeenCalled(); // inherit answered No
    expect(result.outcome).toBe("launch");
    if (result.outcome !== "launch") return;
    expect(result.context?.selectedIds).toEqual(["e1"]);
    expect(result.context?.summary).toBe("e1"); // full conversation = the only message id
    expect(summarize).toHaveBeenCalledTimes(1);
  });

  it("approval without context keeps the fresh-task summary", async () => {
    let title = "";
    await approveInvocation({
      mode: "tui",
      ui: { select: async (value: string) => { title = value; return "Cancel"; } },
    } as unknown as ExtensionContext, registry, request);
    expect(title).toContain("fresh child task only");
  });
});
