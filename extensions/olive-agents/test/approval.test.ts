import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
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
