import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { AgentRecord } from "../src/types.js";
import { FleetList, formatFleetElapsed, formatFleetTokens } from "../src/ui/fleet-list.js";

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
  it("formats compact metrics", () => {
    expect(formatFleetElapsed(1600)).toBe("2s");
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
  it("renders activity targets, not assistant prose, and stays width-safe", () => {
    const r = record({ status: "running", latestActivity: { toolName: "read", action: "reading", target: "src/approval.ts", startedAt: Date.now() } });
    const h = harness([r]);
    expect(h.render().join("\n")).toContain("reading src/approval.ts");
    for (const w of [8, 20, 80]) for (const line of h.render(w)) expect(visibleWidth(line)).toBeLessThanOrEqual(w);
  });
  it("caps overflow", () => {
    const rows = Array.from({ length: 8 }, (_, i) => record({ id: String(i), description: `task ${i}` }));
    expect(harness(rows).render().join("\n")).toMatch(/\+\d+ more/);
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
