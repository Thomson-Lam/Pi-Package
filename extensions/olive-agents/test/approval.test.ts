import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { approveInvocation, availableThinkingLevels } from "../src/approval.js";
import { ContextReviewList } from "../src/ui/context-review.js";
import type { PreparedContextHandoff } from "../src/handoff/types.js";

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
  it("keeps the task prompt out of the proposal and makes review the default action", async () => {
    const select = vi.fn(async (_title: string, _actions: string[]) => "Cancel");
    await approveInvocation(
      { mode: "tui", ui: { select } } as unknown as ExtensionContext,
      registry,
      request,
    );

    const [title, actions] = select.mock.calls[0]!;
    expect(title).not.toContain("Task prompt:");
    expect(actions[0]).toBe("Review / edit task prompt");
  });
  it("launches the edited task", async () => {
    const result = await approveInvocation(ctx(["Review / edit task prompt", "Launch"]), registry, request);
    expect(result).toMatchObject({ outcome: "launch", prompt: "edited" });
    expect(availableThinkingLevels(models[0])).toEqual(["off"]);
  });
  it("uses a ten-row model viewport with regex search and vim page navigation", async () => {
    const modelList = Array.from({ length: 12 }, (_, i) => ({
      provider: "test",
      id: `model-${String(i).padStart(2, "0")}`,
      name: `Model ${i}`,
      reasoning: false,
    })) as unknown as Model<Api>[];
    const selections = [`Change model (${modelList[0]!.provider}/${modelList[0]!.id})`, "Launch"];
    const select = vi.fn(async () => selections.shift());
    const custom = vi.fn(async (factory: any) => {
      let result: Model<Api> | undefined;
      const theme = {
        bold: (text: string) => text,
        fg: (_color: string, text: string) => text,
      };
      const keybindings = {
        matches: (data: string, id: string) =>
          (id === "tui.select.cancel" && (data === "escape" || data === "ctrl+c")) ||
          (id === "tui.select.up" && data === "up") ||
          (id === "tui.select.down" && data === "down") ||
          (id === "tui.select.pageUp" && data === "pageUp") ||
          (id === "tui.select.pageDown" && data === "pageDown") ||
          ((id === "tui.input.submit" || id === "tui.select.confirm") && data === "enter"),
      };
      const component = factory(
        { requestRender() {} },
        theme,
        keybindings,
        (value: Model<Api> | undefined) => { result = value; },
      );

      component.focused = true;
      const initialRender = component.render(100);
      expect(initialRender.filter((line: string) => line.includes("test/model-")).length).toBe(10);
      for (const line of component.render(50)) expect(visibleWidth(line)).toBeLessThanOrEqual(50);

      component.handleInput("/");
      for (const char of "model-1[01]") component.handleInput(char);
      for (const line of component.render(50)) expect(visibleWidth(line)).toBeLessThanOrEqual(50);
      component.handleInput("down");
      component.handleInput("up");
      expect(component.render(100).filter((line: string) => line.includes("test/model-")).length).toBe(2);
      component.handleInput("enter");

      component.handleInput("/");
      component.handleInput("[");
      expect(component.render(100).length).toBe(initialRender.length);
      component.handleInput("escape");
      expect(component.render(100).filter((line: string) => line.includes("test/model-")).length).toBe(2);

      component.handleInput("escape");
      component.handleInput("h");
      component.handleInput("l");
      component.handleInput("enter");
      return result;
    });

    const result = await approveInvocation(
      { mode: "tui", ui: { select, custom } } as unknown as ExtensionContext,
      { find: () => undefined, getAll: () => modelList, getAvailable: () => modelList },
      { ...request, model: modelList[0]! },
    );
    expect(result).toMatchObject({ outcome: "launch", model: modelList[10] });
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

function packetFixture(overrides: Partial<PreparedContextHandoff> = {}): PreparedContextHandoff {
  return {
    version: 1,
    snippets: [],
    recommendedFiles: [],
    snippetProblems: [],
    leadProblems: [],
    packetProblems: [],
    warnings: [],
    totalBytes: 0,
    estimatedTokens: 0,
    ...overrides,
  };
}

function snippetFixture(overrides: Partial<PreparedContextHandoff["snippets"][number]> = {}): PreparedContextHandoff["snippets"][number] {
  return {
    id: "snippet-fixture",
    path: "src/a.ts",
    absolutePath: "/tmp/x/src/a.ts",
    startLine: 1,
    endLine: 2,
    content: "line1\nline2",
    bytes: 11,
    estimatedTokens: 3,
    sourceHash: "h".repeat(64),
    ...overrides,
  };
}

const themeStub = { bold: (text: string) => text, fg: (_color: string, text: string) => text };

function reviewContextCtx(selections: string[], customChoices: Array<{ kind: string; id?: string }>) {
  return {
    mode: "tui",
    ui: {
      select: async () => selections.shift(),
      editor: async () => "edited",
      custom: async () => customChoices.shift(),
    },
  } as unknown as ExtensionContext;
}

describe("constrained-context approval", () => {
  it("does not add a context action when no packet exists", async () => {
    const select = vi.fn(async () => "Cancel");
    await approveInvocation({ mode: "tui", ui: { select } } as unknown as ExtensionContext, registry, request);
    const actions = select.mock.calls[0]![1] as string[];
    expect(actions.some((action) => action.startsWith("Review context"))).toBe(false);
  });

  it("adds a Review context action with packet counts after the task-prompt action", async () => {
    const handoff = packetFixture({
      snippets: [snippetFixture()],
      recommendedFiles: [{ id: "lead-1", path: "other.ts" }],
      estimatedTokens: 6,
      totalBytes: 20,
    });
    const select = vi.fn(async () => "Cancel");
    await approveInvocation(
      { mode: "tui", ui: { select, custom: vi.fn(async () => ({ kind: "back" })) } } as unknown as ExtensionContext,
      registry,
      { ...request, handoff },
    );
    const [title, actions] = select.mock.calls[0]!;
    const list = actions as string[];
    expect(list[0]).toBe("Review / edit task prompt");
    expect(list[1]).toContain("Review context");
    expect(list[1]).toContain("1 snippet");
    expect(list[1]).toContain("1 lead");
    expect(list[1]).toContain("est. 6 tokens");
    expect(title).toContain("Context packet: 1 evidence snippet(s)");
  });

  it("launch returns the final approved packet", async () => {
    const handoff = packetFixture({ snippets: [snippetFixture()] });
    const result = await approveInvocation(ctx(["Launch"]), registry, { ...request, handoff });
    expect(result.outcome).toBe("launch");
    if (result.outcome === "launch") {
      expect(result.handoff?.snippets).toHaveLength(1);
      expect(result.prompt).toBe("task");
    }
  });

  it("launch with context problems routes feedback with each failing reference", async () => {
    const handoff = packetFixture({
      snippetProblems: [{
        id: "p1",
        kind: "missing",
        message: "File does not exist.",
        snippet: { path: "nope.ts", startLine: 1, endLine: 1 },
      }],
      packetProblems: [{ id: "packet-too-large", kind: "too-large", message: "Packet exceeds 5 tokens." }],
    });
    const result = await approveInvocation(ctx(["Launch"]), registry, { ...request, handoff });
    expect(result.outcome).toBe("feedback");
    if (result.outcome === "feedback") {
      expect(result.feedback).toContain("nope.ts:1-1");
      expect(result.feedback).toContain("missing");
      expect(result.feedback).toContain("too-large");
    }
  });

  it("removing a problem item during review enables launch", async () => {
    const handoff = packetFixture({
      snippetProblems: [{
        id: "p1",
        kind: "missing",
        message: "File does not exist.",
        snippet: { path: "nope.ts", startLine: 1, endLine: 1 },
      }],
    });
    const result = await approveInvocation(
      reviewContextCtx(["Review context (…)", "Launch"], [{ kind: "remove", id: "p1" }, { kind: "back" }]),
      registry,
      { ...request, handoff },
    );
    expect(result.outcome).toBe("launch");
  });

  it("removing every item empties the packet and launches fresh", async () => {
    const handoff = packetFixture({ snippets: [snippetFixture()] });
    const result = await approveInvocation(
      reviewContextCtx(["Review context (…)", "Launch"], [{ kind: "remove", id: "snippet-fixture" }, { kind: "back" }]),
      registry,
      { ...request, handoff },
    );
    expect(result.outcome).toBe("launch");
    if (result.outcome === "launch") expect(result.handoff).toBeUndefined();
  });

  it("warns when inheritance and a packet are combined", async () => {
    const handoff = packetFixture({ snippets: [snippetFixture()] });
    const select = vi.fn(async () => "Cancel");
    await approveInvocation(
      { mode: "tui", ui: { select, custom: vi.fn(async () => ({ kind: "back" })) } } as unknown as ExtensionContext,
      registry,
      { ...request, inheritContext: true, handoff },
    );
    const title = select.mock.calls[0]![0] as string;
    expect(title).toContain("may duplicate content");
  });

  it("keeps a large excerpt out of the top-level summary", async () => {
    const handoff = packetFixture({
      snippets: [snippetFixture({ content: "A".repeat(100_000), bytes: 100_000, estimatedTokens: 25_000 })],
    });
    const select = vi.fn(async () => "Cancel");
    await approveInvocation(
      { mode: "tui", ui: { select, custom: vi.fn(async () => ({ kind: "back" })) } } as unknown as ExtensionContext,
      registry,
      { ...request, handoff },
    );
    const title = select.mock.calls[0]![0] as string;
    expect(title).not.toContain("AAAAA");
  });

  it("oversized packet problems must be resolved by removal, not bypassed", async () => {
    const handoff = packetFixture({
      snippets: [snippetFixture()],
      packetProblems: [{ id: "packet-too-large", kind: "too-large", message: "Packet exceeds 5 tokens." }],
    });
    const result = await approveInvocation(ctx(["Launch"]), registry, { ...request, handoff });
    expect(result.outcome).toBe("feedback");
  });

  it("opens the exact excerpt in the view-only editor from the review", async () => {
    const handoff = packetFixture({ snippets: [snippetFixture()] });
    const editorContent = vi.fn(async (_title: string, content: string) => content);
    const customChoices = [{ kind: "view", id: "snippet-fixture" }, { kind: "back" }];
    const selections = ["Review context (…)", "Cancel"];
    const result = await approveInvocation(
      {
        mode: "tui",
        ui: {
          select: async () => selections.shift(),
          editor: editorContent,
          custom: async () => customChoices.shift(),
        },
      } as unknown as ExtensionContext,
      registry,
      { ...request, handoff },
    );
    expect(result).toEqual({ outcome: "cancel" });
    expect(editorContent).toHaveBeenCalledWith(expect.stringContaining("src/a.ts:1-2"), "line1\nline2");
  });

  it("cancels the whole approval when the review returns cancelled (custom resolved undefined)", async () => {
    const handoff = packetFixture({ snippets: [snippetFixture()] });
    const result = await approveInvocation(
      reviewContextCtx(["Review context (…)", "Launch"], [undefined as any]),
      registry,
      { ...request, handoff },
    );
    // The cancelled review must abort the approval — Launch must never run.
    expect(result.outcome).toBe("cancel");
  });
});
