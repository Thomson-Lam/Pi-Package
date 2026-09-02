import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { AgentRecord } from "../src/types.js";
import { zellijName } from "../src/names.js";
import { FleetList, formatFleetTokens } from "../src/ui/fleet-list.js";

const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
const record = (over: Partial<AgentRecord> = {}) => ({
  id: "a", type: "Explore", description: "inspect lifecycle", status: "queued",
  toolUses: 0, startedAt: Date.now(), lifetimeUsage: { input: 1200, output: 0, cacheWrite: 0 }, compactionCount: 0,
  originalPrompt: "inspect", effectivePrompt: "inspect", updatedAt: Date.now(), runNumber: 1, turnCount: 0,
  ...over,
}) as AgentRecord;

function harness(records: AgentRecord[]) {
  let factory: any;
  const manager = {
    listAgents: () => records,
    getRecord: (id: string) => records.find((r) => r.id === id),
    subscribe: vi.fn(() => () => {}),
  } as any;
  const fleet = new FleetList(manager);
  const ui = { setWidget: vi.fn((_key: string, content: any) => { factory = content; }) };
  fleet.setUICtx(ui);
  const tui = { requestRender: vi.fn() };
  return { fleet, ui, render: (w = 100) => factory ? factory(tui, theme).render(w) : [] };
}

describe("passive FleetList", () => {
  it("formats compact token metrics", () => {
    expect(formatFleetTokens(1200)).toBe("1.2k");
  });
  it("shows queued records before a session exists and captures no input", () => {
    const h = harness([record()]);
    expect(h.render().join("\n")).toContain("inspect lifecycle");
    expect(h.render().join("\n")).toContain("queued");
    expect((h.ui as any).onTerminalInput).toBeUndefined();
  });
  it("retains terminal unreviewed records and hides reviewed ones", () => {
    const done = record({ status: "completed", completedAt: Date.now() });
    expect(harness([done]).render().join("\n")).toContain("inspect lifecycle");
    done.reviewedAt = Date.now();
    expect(harness([done]).render()).toEqual([]);
  });
  it("renders one width-safe row without activity text or elapsed time", () => {
    const r = record({ status: "running", latestActivity: { toolName: "read", action: "reading", target: "src/approval.ts", startedAt: Date.now() } });
    const h = harness([r]);
    const output = h.render().join("\n");
    expect(output).not.toContain("reading src/approval.ts");
    expect(output).not.toMatch(/\d+s/);
    expect(h.render()).toHaveLength(1);
    for (const w of [8, 20, 80]) for (const line of h.render(w)) expect(visibleWidth(line)).toBeLessThanOrEqual(w);
  });
  it("caps overflow", () => {
    const rows = Array.from({ length: 12 }, (_, i) => record({ id: String(i), description: `task ${i}` }));
    expect(harness(rows).render().join("\n")).toMatch(/\+\d+ more/);
  });
  it("prioritizes decision rows and renders only the Alt+A hint", () => {
    const waiting = record({ id: "wait", description: "waiting task", status: "awaiting_decision", decision: { reason: "turn_limit", requestedAt: Date.now() - 42000, result: "status", turnCount: 10, toolUses: 2, maxTurns: 10 }, maxTurns: 10, turnCount: 10, window: { id: "@3", index: 3, name: "agent", state: "closed" } });
    const running = record({ id: "run", description: "running task", status: "running", updatedAt: Date.now() + 1000 });
    const output = harness([running, waiting]).render().join("\n");
    expect(output).toContain("Alt+A open");
    expect(output).not.toContain("needs input");
    expect(output).not.toContain("⚠");
    expect(output).not.toContain("↳");
    expect(output.indexOf("waiting task")).toBeLessThan(output.indexOf("running task"));
    expect(output).toContain("(closed)");
  });
  it("highlights the waiting agent name", () => {
    const waiting = record({ id: "wait", status: "awaiting_decision" });
    const h = harness([waiting]);
    const styledTheme = { fg: vi.fn((_color: string, text: string) => text), bold: (text: string) => text };
    h.fleet.renderRows(styledTheme, "wait");
    expect(styledTheme.fg).toHaveBeenCalledWith("warning", zellijName("wait"));
  });
});

describe("fleet selection mode", () => {
  it("begins selection on the first record and renders a cursor", () => {
    const r = record({ id: "a", status: "running" });
    const h = harness([r]);
    h.fleet.beginSelection();
    expect(h.fleet.selectedRecord()?.id).toBe("a");
    expect(h.render().join("\n")).toContain("›");
  });

  it("cycles selection with moveSelection and wraps", () => {
    const rows = [
      record({ id: "a", status: "running" }),
      record({ id: "b", status: "completed", completedAt: Date.now() }),
    ];
    const h = harness(rows);
    h.fleet.beginSelection();
    expect(h.fleet.selectedRecord()?.id).toBe("a");
    h.fleet.moveSelection(1);
    expect(h.fleet.selectedRecord()?.id).toBe("b");
    h.fleet.moveSelection(1);
    expect(h.fleet.selectedRecord()?.id).toBe("a");
    h.fleet.moveSelection(-1);
    expect(h.fleet.selectedRecord()?.id).toBe("b");
  });

  it("selectableRecords includes terminal records running-first", () => {
    const done = record({ id: "done", status: "completed", completedAt: Date.now(), updatedAt: Date.now() - 1000 });
    const run = record({ id: "run", status: "running", updatedAt: Date.now() });
    const h = harness([done, run]);
    expect(h.fleet.selectableRecords().map((r) => r.id)).toEqual(["run", "done"]);
  });

  it("endSelection clears selection mode", () => {
    const h = harness([record({ id: "a", status: "running" })]);
    h.fleet.beginSelection();
    expect(h.fleet.selecting).toBe(true);
    h.fleet.endSelection();
    expect(h.fleet.selecting).toBe(false);
    expect(h.render().join("\n")).not.toContain("›");
  });

  it("renders the tmux window index on the row", () => {
    const r = record({ id: "a", status: "running", window: { id: "@3", index: 3, name: "agent-review", state: "alive" } });
    expect(harness([r]).render().join("\n")).toContain("tmux 3");
  });

  it("renders a closed window as reopenable", () => {
    const r = record({ id: "a", status: "completed", completedAt: Date.now(), window: { id: "@3", index: 3, name: "agent-review", state: "closed" } });
    expect(harness([r]).render().join("\n")).toContain("(closed)");
  });
});
