import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { approveInvocation, approveManualLaunch, buildLedgerContext, DEFAULT_HANDOFF_COMPACTION_PROMPT } from "../src/approval.js";

const model = { provider: "test", id: "basic", name: "Basic", reasoning: false } as unknown as Model<Api>;
const registry = { getAll: () => [model], getAvailable: () => [model] };
const request = {
  agentType: "Review", description: "Inspect code", prompt: "task", model,
  thinking: "off" as const, maxTurns: 10, runInBackground: false,
};

function ctx(selection: string) {
  return { mode: "tui", ui: { select: async () => selection } } as unknown as ExtensionContext;
}

describe("subagent approval", () => {
  it("keeps default handoff compaction complementary to the implementation plan", () => {
    expect(DEFAULT_HANDOFF_COMPACTION_PROMPT).toContain("implementation plan separately");
    expect(DEFAULT_HANDOFF_COMPACTION_PROMPT).toContain("flat bullet list with no heading or sections");
    expect(DEFAULT_HANDOFF_COMPACTION_PROMPT).toContain("how competing options were resolved");
    expect(DEFAULT_HANDOFF_COMPACTION_PROMPT).toContain("known limitations, deferrals, or excluded work");
    expect(DEFAULT_HANDOFF_COMPACTION_PROMPT).toContain("Never narrate the conversation");
    expect(DEFAULT_HANDOFF_COMPACTION_PROMPT).toContain("Do not repeat implementation-plan details");
    expect(DEFAULT_HANDOFF_COMPACTION_PROMPT).toContain("Do not add recommendations, next steps, TODOs");
    expect(DEFAULT_HANDOFF_COMPACTION_PROMPT).not.toContain("under 100 words");
  });

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
      outcome: "launch", prompt: "task", model, thinking: "off", maxTurns: 10, runInBackground: false,
    });
  });

  it("offers detach instead of blocking the parent on the child", async () => {
    let title = "";
    const answers = ["Change parent behavior (Detach from child)", "Continue working", "Launch"];
    const result = await approveInvocation({
      mode: "tui",
      ui: { select: async (value: string) => { title = value; return answers.shift(); } },
    } as unknown as ExtensionContext, registry, request);
    expect(title).not.toContain("Wait for child");
    expect(result).toMatchObject({ outcome: "launch", maxTurns: 10, runInBackground: true });
  });

  it("starts with an external ledger context without offering current-session context building", async () => {
    let title = "";
    let actions: string[] = [];
    const external = { version: 1, id: "external", sourceSessionName: "other session", createdAt: "2025-01-01T00:00:00.000Z", selections: [] };
    const result = await approveInvocation({
      mode: "tui",
      ui: {
        select: async (value: string, offered: string[]) => {
          title = value;
          actions = offered;
          return "Launch";
        },
      },
    } as unknown as ExtensionContext, registry, {
      ...request,
      initialContext: { selectedIds: [], inheritedNodes: [external] },
    });
    expect(title).toContain("include 1 parent context");
    expect(actions).not.toContain("Build context");
    expect(result).toMatchObject({ outcome: "launch", context: { selectedIds: [], inheritedNodes: [external] } });
  });

  it("manual approval only offers prompt review, launch, and cancel", async () => {
    let actions: string[] = [];
    const result = await approveManualLaunch({
      mode: "tui",
      ui: {
        select: async (_title: string, offered: string[]) => {
          actions = offered;
          return "Launch";
        },
      },
    } as unknown as ExtensionContext, {
      ...request,
      maxTurns: undefined,
      initialContext: { selectedIds: ["e1"], inheritedNodes: [] },
    });
    expect(actions).toEqual(["Review / edit task prompt", "Launch", "Cancel"]);
    expect(result).toMatchObject({ outcome: "launch", maxTurns: undefined });
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

  /** Drive the bounded model picker without depending on Pi's terminal runtime. */
  function chooseModel(factory: any, moves = 0, inspect?: (lines: string[]) => void): Promise<Model<Api> | undefined> {
    return new Promise((resolve) => {
      const component = factory(
        { requestRender: () => {} },
        { fg: (_color: string, text: string) => text, bold: (text: string) => text },
        { matches: (data: string, binding: string) => data === "enter" && binding === "tui.select.confirm" },
        resolve,
      );
      inspect?.(component.render(80));
      for (let i = 0; i < moves; i++) component.handleInput("j");
      component.handleInput("enter");
    });
  }

  it("flow: select → inherit Yes (tree) → no compaction → launch", async () => {
    const ui = {
      select: selectQueue(["Build context", "Yes", "None"]),
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
      select: selectQueue(["Build context", "Yes", "None"]),
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
      select: selectQueue(["Build context", "None"]), // no inherit select slot
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

  it("default compaction summarizes the FULL conversation and reviews the output", async () => {
    // select queue: builder, inherit ? No, compact ? Default → loader follows.
    const ui = {
      select: selectQueue(["Build context", "No", "Default", "Use this output"]),
      editor: async () => "reviewed summary",
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
    expect(result.context?.summary).toBe("reviewed summary"); // editor output becomes ledger context
    expect(summarize).toHaveBeenCalledWith(
      branch,
      ["e1"],
      model,
      "off",
      DEFAULT_HANDOFF_COMPACTION_PROMPT,
    );
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

  it("configures custom compaction before generation and recompacts with feedback", async () => {
    const select = selectQueue([
      "Build context", "Custom", "off", "Recompact with feedback", "Use this output",
    ]);
    const editorTitles: string[] = [];
    let summarizeCount = 0;
    let customCall = 0;
    const ui = {
      select,
      custom: async (factory: any) => {
        customCall++;
        if (customCall === 1) return { selectedIds: ["e1"] };
        if (customCall === 2) return chooseModel(factory);
        return new Promise((resolve) => factory(null, null, null, resolve));
      },
      editor: async (title: string, prefill: string) => {
        editorTitles.push(title);
        if (title === "Compaction prompt") return "Preserve only settled architecture decisions.";
        if (title === "Feedback for re-compaction") return "Keep the accepted architecture decision.";
        return prefill;
      },
    };
    const summarize = vi.fn((_branch, _ids, _model, _thinking, instructions) => {
      summarizeCount++;
      return Promise.resolve(`summary ${summarizeCount}\n${instructions}`);
    });

    const result = await approveInvocation(
      { mode: "tui", ui } as unknown as ExtensionContext,
      registry,
      request,
      { branch, candidates: [], summarize },
    );

    expect(result.outcome).toBe("launch");
    if (result.outcome !== "launch") return;
    expect(result.context?.summary).toContain("summary 2");
    expect(summarize).toHaveBeenCalledTimes(2);
    expect(summarize.mock.calls[0]?.[4]).toBe("Preserve only settled architecture decisions.");
    expect(summarize.mock.calls[1]?.[4]).toContain("Keep the accepted architecture decision.");
    expect(editorTitles).toEqual([
      "Compaction prompt",
      "Review compacted handoff (edit to use)",
      "Feedback for re-compaction",
      "Review compacted handoff (edit to use)",
    ]);
  });

  it("reuses the same selector and compaction flow for a return without inheritance", async () => {
    const titles: string[] = [];
    const ui = {
      select: async (title: string) => {
        titles.push(title);
        return "None";
      },
      custom: async () => ({ selectedIds: ["e1"] }),
    };
    const openInheritTree = vi.fn(async () => candidates);
    const result = await buildLedgerContext(
      { mode: "tui", ui } as unknown as ExtensionContext,
      registry,
      request,
      { branch, candidates, summarize: () => Promise.resolve("summary"), openInheritTree },
      {
        allowInheritance: false,
        title: "Select context to return to parent",
        compactQuestion: "Compact all new child conversation before return?",
      },
    );
    expect(result?.selectedIds).toEqual(["e1"]);
    expect(openInheritTree).not.toHaveBeenCalled();
    expect(titles).toEqual(["Compact all new child conversation before return?"]);
  });

  it("uses independently selected model and reasoning for compaction", async () => {
    const compactModel = {
      provider: "test", id: "compact", name: "Compact", reasoning: true,
      maxTokens: 8192, contextWindow: 128000,
    } as unknown as Model<Api>;
    const extraModels = Array.from({ length: 12 }, (_, i) => ({
      provider: "test", id: `extra-${i.toString().padStart(2, "0")}`, name: `Extra ${i}`,
      reasoning: false, maxTokens: 8192, contextWindow: 128000,
    } as unknown as Model<Api>));
    const compactRegistry = {
      getAll: () => [model, compactModel, ...extraModels],
      getAvailable: () => [model, compactModel, ...extraModels],
    };
    let customCall = 0;
    let pickerLines: string[] = [];
    const ui = {
      select: selectQueue([
        "Build context", "Custom", "high", "Use this output",
      ]),
      custom: async (factory: any) => {
        customCall++;
        if (customCall === 1) return { selectedIds: ["e1"] };
        if (customCall === 2) return chooseModel(factory, 1, (lines) => { pickerLines = lines; });
        return new Promise((resolve) => factory(null, null, null, resolve));
      },
      editor: async (_title: string, prefill: string) => prefill,
      notify: vi.fn(),
    };
    const summarize = vi.fn((_branch, _ids, selectedModel, thinking) =>
      Promise.resolve(`${selectedModel.provider}/${selectedModel.id}:${thinking}`));

    const result = await approveInvocation(
      { mode: "tui", ui } as unknown as ExtensionContext,
      compactRegistry,
      request,
      { branch, candidates: [], summarize },
    );

    expect(result.outcome).toBe("launch");
    if (result.outcome !== "launch") return;
    expect(result.context?.summary).toBe("test/compact:high");
    expect(pickerLines[0]).toBe("Select compaction model");
    expect(pickerLines.filter((line) => line.includes("test/")).length).toBe(10);
    expect(pickerLines).toContain("  (1/14)");
    expect(summarize).toHaveBeenCalledWith(
      branch,
      ["e1"],
      compactModel,
      "high",
      expect.any(String),
    );
  });
});
