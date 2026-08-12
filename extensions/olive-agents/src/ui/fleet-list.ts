/** Passive compact overview of active and terminal-unreviewed agents, plus a
 *  selection mode used by the Alt+A agent-session picker. */
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentManager } from "../agent-manager.js";
import { agentTypeSlug, zellijName } from "../names.js";
import type { AgentRecord } from "../types.js";
import { getLifetimeTotal } from "../usage.js";
import type { Theme } from "./format.js";

const FLEET_KEY = "fleet";
const MAX_LINES = 10;
const TICK_MS = 1000;

export type FleetUICtx = {
  setWidget(
    key: string,
    content: undefined | ((tui: any, theme: Theme) => { render(width: number): string[]; invalidate(): void }),
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
};

export function formatFleetElapsed(ms: number): string {
  return `${Math.max(0, Math.round(ms / 1000))}s`;
}

export function formatFleetTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}

function terminal(record: AgentRecord): boolean {
  return record.status !== "running" && record.status !== "queued";
}

function icon(record: AgentRecord): string {
  if (record.status === "running") return "●";
  if (record.status === "queued") return "◌";
  if (record.status === "completed" || record.status === "steered") return "✓";
  if (record.status === "stopped") return "■";
  return "!";
}

function align(left: string, right: string, width: number): string {
  const room = Math.max(0, width - visibleWidth(right) - 1);
  const l = truncateToWidth(left, room);
  return truncateToWidth(`${l}${" ".repeat(Math.max(1, width - visibleWidth(l) - visibleWidth(right)))}${right}`, width);
}

export class FleetList {
  private ui?: FleetUICtx;
  private tui?: any;
  private registered = false;
  private timer?: ReturnType<typeof setInterval>;
  private unsubscribe: () => void;
  /** Selected record id while in selection mode (or when a picker is open). */
  selectedId?: string;
  /** True while the Alt+A picker is open (selection is visible). */
  selecting = false;

  constructor(private manager: AgentManager) {
    this.unsubscribe = manager.subscribe(() => this.update());
  }

  setUICtx(ui: FleetUICtx): void {
    if (this.ui === ui) return;
    if (this.ui && this.registered) this.ui.setWidget(FLEET_KEY, undefined);
    this.ui = ui;
    this.registered = false;
    this.tui = undefined;
    this.update();
  }

  /** Records eligible for the fleet: running/queued or terminal-unreviewed. */
  records(): AgentRecord[] {
    return this.manager.listAgents()
      .filter(r => !terminal(r) || r.reviewedAt == null)
      .sort((a, b) => {
        const aa = terminal(a) ? 1 : 0;
        const bb = terminal(b) ? 1 : 0;
        return aa - bb || b.updatedAt - a.updatedAt;
      });
  }

  update(): void {
    if (!this.ui) return;
    const records = this.records();
    if (records.length === 0) {
      if (this.registered) this.ui.setWidget(FLEET_KEY, undefined);
      this.registered = false;
      this.tui = undefined;
      this.stopTimer();
      return;
    }
    if (records.some(r => r.status === "running" || r.status === "queued")) this.startTimer();
    else this.stopTimer();
    if (!this.registered) {
      this.ui.setWidget(FLEET_KEY, (tui, theme) => {
        this.tui = tui;
        return { render: (width) => this.render(width, theme), invalidate: () => {} };
      }, { placement: "belowEditor" });
      this.registered = true;
    } else this.tui?.requestRender();
  }

  private startTimer(): void {
    if (!this.timer) {
      this.timer = setInterval(() => this.tui?.requestRender(), TICK_MS);
      this.timer.unref?.();
    }
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Render the fleet rows (shared by the widget and the selection picker). */
  renderRows(theme: Theme, selectedId?: string, width = 120): string[] {
    const all = this.records();
    const lines: string[] = [];
    let shown = 0;
    for (const record of all) {
      if (lines.length + 2 > MAX_LINES) break;
      const elapsed = formatFleetElapsed((record.completedAt ?? Date.now()) - record.startedAt);
      const total = formatFleetTokens(getLifetimeTotal(record.lifetimeUsage));
      const windowPart = record.window
        ? `tmux ${record.window.state === "closed" ? `${record.window.index} (closed)` : record.window.index}`
        : record.status === "queued" ? "queued" : undefined;
      const metrics = [windowPart, elapsed, total !== "0" ? `${total} tok` : undefined,
        record.maxTurns ? `${record.turnCount}/${record.maxTurns} turns` : record.turnCount ? `${record.turnCount} turns` : undefined,
      ].filter(Boolean).join(" · ");
      const color = record.status === "running" ? "accent" : terminal(record) && record.status !== "completed" ? "warning" : "dim";
      const isSelected = record.id === selectedId;
      const cursor = isSelected ? theme.fg("accent", "› ") : "  ";
      const name = zellijName(record.id);
      const nameStyled = isSelected ? theme.fg("accent", name) : theme.fg("muted", name);
      const typeTag = theme.fg("dim", `(${agentTypeSlug(record.type)})`);
      const left = `${cursor}${theme.fg(color, icon(record))} ${nameStyled} ${typeTag}  ${record.description}`;
      lines.push(align(left, theme.fg("dim", metrics), width));
      const activity = record.status === "queued" ? "queued"
        : record.latestActivity ? `${record.latestActivity.action}${record.latestActivity.target ? ` ${record.latestActivity.target}` : ""}`
        : terminal(record) ? record.error ?? record.stopReason ?? "review required"
        : record.window?.state === "starting" ? "starting…" : "thinking";
      lines.push(truncateToWidth(`  ${theme.fg("dim", `↳ ${activity}`)}`, width));
      shown++;
    }
    if (shown < all.length) lines.push(truncateToWidth(theme.fg("dim", `+${all.length - shown} more`), width));
    return lines;
  }

  private render(width: number, theme: Theme): string[] {
    return this.renderRows(theme, this.selecting ? this.selectedId : undefined, width);
  }

  // ---- Selection mode ----

  /** Selectable records for the picker (all records, running first). */
  selectableRecords(): AgentRecord[] {
    return this.manager.listAgents().sort((a, b) => {
      const aa = terminal(a) ? 1 : 0;
      const bb = terminal(b) ? 1 : 0;
      return aa - bb || b.updatedAt - a.updatedAt;
    });
  }

  beginSelection(): void {
    const records = this.selectableRecords();
    this.selecting = true;
    if (!this.selectedId || !records.some((r) => r.id === this.selectedId)) {
      this.selectedId = records[0]?.id;
    }
    this.update();
  }

  moveSelection(delta: number): void {
    const records = this.selectableRecords();
    if (records.length === 0) return;
    const current = Math.max(0, records.findIndex((r) => r.id === this.selectedId));
    this.selectedId = records[(current + delta + records.length) % records.length]?.id;
    this.update();
  }

  endSelection(): void {
    this.selecting = false;
    this.update();
  }

  selectedRecord(): AgentRecord | undefined {
    return this.selectedId ? this.manager.getRecord(this.selectedId) : undefined;
  }

  dispose(): void {
    this.stopTimer();
    this.unsubscribe();
    if (this.ui && this.registered) this.ui.setWidget(FLEET_KEY, undefined);
    this.registered = false;
    this.ui = undefined;
    this.tui = undefined;
  }
}
