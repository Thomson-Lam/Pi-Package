import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { inspectorState, setLastReconstructed } from "../state.js";
import { buildContextItems, summarizeCounts, uniqueReadFileCount } from "../reconstruct.js";
import type { ContextItem, InspectorMode } from "../types.js";
import { buildDetailText } from "./detail.js";
import { refreshWidget } from "./widget.js";

export async function openContextPanel(ctx: ExtensionContext) {
  if (!(ctx as any).hasUI && (ctx as any).hasUI !== undefined) {
    ctx.ui.notify("Context Inspector needs interactive UI.", "warning");
    return;
  }

  inspectorState.panelOpen = true;
  rebuild(ctx);

  await ctx.ui.custom<void>((tui: any, theme: any, _keybindings: any, done: (value: void) => void) => {
    const panel = new ContextPanel(ctx, tui, theme, done);
    return panel;
  }, {
    overlay: true,
    overlayOptions: {
      width: "72%",
      minWidth: 46,
      maxHeight: "82%",
      anchor: "center",
      visible: (termWidth: number) => termWidth >= 80,
    },
  });

  inspectorState.panelOpen = false;
  inspectorState.mode = "list";
  inspectorState.detailItemId = undefined;
  refreshWidget(ctx);
}

export function rebuild(ctx: any): ContextItem[] {
  const items = buildContextItems(ctx, inspectorState);
  setLastReconstructed(items);
  return items;
}

class ContextPanel {
  private searching = false;
  private scroll = 0;
  private detailScroll = 0;

  constructor(
    private ctx: any,
    private tui: any,
    private theme: any,
    private done: (value: void) => void,
  ) {}

  render(width: number): string[] {
    rebuild(this.ctx);
    const mode = inspectorState.mode;
    const innerWidth = Math.max(10, width - 2);
    const lines: string[] = [];
    lines.push(this.fit(innerWidth, this.theme.fg("accent", this.theme.bold("Context Inspector")) + this.theme.fg("dim", "  Files read + snapshots")));

    if (mode === "summary") this.renderSummary(lines, innerWidth);
    else if (mode === "detail") this.renderDetail(lines, innerWidth);
    else this.renderList(lines, innerWidth);

    const help = this.searching
      ? `filter: ${inspectorState.filter}  enter done • esc clear`
      : "j/k nav • enter snapshot • h back • s summary • l list • / filter • esc close";
    lines.push(this.fit(innerWidth, this.theme.fg("dim", help)));

    const top = this.theme.fg("borderAccent", `┌${"─".repeat(innerWidth)}┐`);
    const bottom = this.theme.fg("borderAccent", `└${"─".repeat(innerWidth)}┘`);
    return [
      top,
      ...lines.map((line) => this.theme.fg("borderAccent", "│") + padToWidth(this.fit(innerWidth, line), innerWidth) + this.theme.fg("borderAccent", "│")),
      bottom,
    ];
  }

  handleInput(data: string): void {
    if (this.searching) {
      if (isKey(data, "escape")) {
        inspectorState.filter = "";
        this.searching = false;
      } else if (isKey(data, "enter")) {
        this.searching = false;
      } else if (isKey(data, "backspace")) {
        inspectorState.filter = inspectorState.filter.slice(0, -1);
      } else if (data.length === 1 && data >= " ") {
        inspectorState.filter += data;
      }
      inspectorState.selectedIndex = 0;
      this.invalidateAndRender();
      return;
    }

    if (isKey(data, "escape") || isKey(data, "ctrl+c")) {
      this.done();
      return;
    }
    if (data === "k" || isKey(data, "up")) this.scrollOrMove(-1);
    else if (data === "j" || isKey(data, "down")) this.scrollOrMove(1);
    else if (isKey(data, "pageUp")) this.scrollOrMove(-10);
    else if (isKey(data, "pageDown")) this.scrollOrMove(10);
    else if (data === "g" && inspectorState.mode === "detail") this.detailScroll = 0;
    else if (data === "G" && inspectorState.mode === "detail") this.detailScroll = Number.MAX_SAFE_INTEGER;
    else if (isKey(data, "enter")) this.openDetail();
    else if (data === "h") this.back();
    else if (data === "s") this.setMode("summary");
    else if (data === "l") this.setMode("list");
    else if (data === "/" || data === "f") {
      this.searching = true;
    }
    this.invalidateAndRender();
  }

  invalidate(): void {}

  private renderSummary(lines: string[], width: number) {
    const items = filteredItems();
    const c = summarizeCounts(items);
    lines.push("");
    lines.push(this.fit(width, this.theme.fg("accent", "Summary")));
    const rows = [
      ["unique files", uniqueReadFileCount(items)], ["read snapshots", c.readFile], ["context files", c.contextFile],
      ["summaries", c.compactionSummary + c.branchSummary], ["active", c.active], ["system", c.system],
      ["likely-active", c.likelyActive], ["summarized", c.summarized], ["historical", c.historical],
    ];
    for (const [label, count] of rows) {
      lines.push(this.fit(width, `  ${String(label).padEnd(16)} ${this.theme.fg("accent", String(count))}`));
    }
    if (!inspectorState.lastSystemPrompt) {
      lines.push("", this.fit(width, this.theme.fg("warning", "No before_agent_start snapshot captured yet.")));
    }
  }

  private renderList(lines: string[], width: number) {
    const items = filteredItems();
    if (items.length === 0) {
      lines.push("", this.fit(width, this.theme.fg("warning", "No file snapshots to show.")));
      lines.push(this.fit(width, this.theme.fg("dim", "Ask the agent to read files, then reopen /reads.")));
      return;
    }
    const height = 24;
    const selected = clamp(inspectorState.selectedIndex, 0, items.length - 1);
    inspectorState.selectedIndex = selected;
    if (selected < this.scroll) this.scroll = selected;
    if (selected >= this.scroll + height) this.scroll = selected - height + 1;
    const visible = items.slice(this.scroll, this.scroll + height);
    lines.push(this.fit(width, this.theme.fg("dim", `Items ${this.scroll + 1}-${this.scroll + visible.length} of ${items.length}${inspectorState.filter ? ` • filter: ${inspectorState.filter}` : ""}`)));
    for (const [offset, item] of visible.entries()) {
      const idx = this.scroll + offset;
      const selectedRow = idx === selected;
      const marker = selectedRow ? "›" : " ";
      const row = `${marker} ${icon(item)} ${statusBadge(item.status)} ${item.title}${item.path && !item.title.includes(item.path) ? ` — ${item.path}` : ""}`;
      const styled = selectedRow ? this.theme.bg("selectedBg", this.theme.fg("accent", row)) : row;
      lines.push(this.fit(width, styled));
    }
  }

  private renderDetail(lines: string[], width: number) {
    const item = currentItem();
    if (!item) {
      lines.push("", this.fit(width, this.theme.fg("warning", "No selected item.")));
      return;
    }
    const text = buildDetailText(item, this.ctx.cwd);
    const wrapped = text.split("\n").flatMap((line) => wrapText(line || " ", Math.max(10, width - 2)));
    const pageSize = 30;
    const maxScroll = Math.max(0, wrapped.length - pageSize);
    this.detailScroll = clamp(this.detailScroll, 0, maxScroll);
    const visible = wrapped.slice(this.detailScroll, this.detailScroll + pageSize);
    lines.push(this.fit(width, this.theme.fg("dim", `Snapshot lines ${this.detailScroll + 1}-${this.detailScroll + visible.length} of ${wrapped.length}`)));
    for (const line of visible) lines.push(this.fit(width, ` ${line}`));
    if (wrapped.length > pageSize) lines.push(this.fit(width, this.theme.fg("dim", " j/k scroll • pageUp/pageDown • g top • G bottom")));
  }

  private scrollOrMove(delta: number) {
    if (inspectorState.mode === "detail") {
      this.detailScroll = Math.max(0, this.detailScroll + delta);
      return;
    }
    this.move(delta);
  }

  private move(delta: number) {
    if (inspectorState.mode !== "list") return;
    const len = filteredItems().length;
    inspectorState.selectedIndex = clamp(inspectorState.selectedIndex + delta, 0, Math.max(0, len - 1));
  }

  private openDetail() {
    if (inspectorState.mode === "summary") {
      inspectorState.mode = "list";
      return;
    }
    const item = currentItem();
    if (!item) return;
    inspectorState.detailItemId = item.id;
    inspectorState.mode = "detail";
    this.detailScroll = 0;
  }

  private back() {
    if (inspectorState.mode === "detail") inspectorState.mode = "list";
    else if (inspectorState.mode === "summary") inspectorState.mode = "list";
  }

  private setMode(mode: InspectorMode) {
    inspectorState.mode = mode;
    if (mode !== "detail") inspectorState.detailItemId = undefined;
  }

  private invalidateAndRender() {
    this.tui.requestRender();
  }

  private fit(width: number, line: string): string {
    return truncateToWidth(line, width, "…");
  }
}

function filteredItems(): ContextItem[] {
  const q = inspectorState.filter.trim().toLowerCase();
  const items = inspectorState.lastReconstructed;
  if (!q) return items;
  return items.filter((i) => [i.title, i.sourceLabel, i.path, i.preview, i.type, i.status].filter(Boolean).join(" ").toLowerCase().includes(q));
}

function currentItem(): ContextItem | undefined {
  if (inspectorState.detailItemId) return inspectorState.lastReconstructed.find((i) => i.id === inspectorState.detailItemId);
  return filteredItems()[inspectorState.selectedIndex];
}

function icon(item: ContextItem): string {
  switch (item.type) {
    case "systemPrompt": return "S";
    case "contextFile": return "A";
    case "skill": return "K";
    case "readFile": return "F";
    case "userMessage": return "U";
    case "assistantMessage": return "M";
    case "toolCall": return "T";
    case "toolResult": return "R";
    case "compactionSummary": return "C";
    case "branchSummary": return "B";
    case "customMessage": return "X";
  }
}

function statusBadge(status: string): string {
  if (status === "likely-active") return "[likely]";
  return `[${status.slice(0, 3)}]`;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function isKey(data: string, key: "escape" | "enter" | "backspace" | "up" | "down" | "pageUp" | "pageDown" | "ctrl+c"): boolean {
  const map: Record<typeof key, string[]> = {
    escape: ["\u001b"],
    enter: ["\r", "\n"],
    backspace: ["\u007f", "\b"],
    up: ["\u001b[A"],
    down: ["\u001b[B"],
    pageUp: ["\u001b[5~"],
    pageDown: ["\u001b[6~"],
    "ctrl+c": ["\u0003"],
  };
  return map[key].includes(data);
}

function truncateToWidth(input: string, width: number, ellipsis = "…"): string {
  if (width <= 0) return "";
  const plain = stripAnsi(input);
  if (plain.length <= width) return input;
  const target = Math.max(0, width - ellipsis.length);
  // Rows in this panel apply ANSI only as whole-line wrappers, so plain truncation is safe enough.
  return plain.slice(0, target) + ellipsis;
}

function wrapText(input: string, width: number): string[] {
  const text = stripAnsi(input);
  if (text.length <= width) return [text];
  const words = text.split(/(\s+)/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (!word) continue;
    if ((line + word).length > width && line.trim()) {
      lines.push(line.trimEnd());
      line = word.trimStart();
    } else {
      line += word;
    }
    while (line.length > width) {
      lines.push(line.slice(0, width));
      line = line.slice(width);
    }
  }
  if (line || lines.length === 0) lines.push(line.trimEnd());
  return lines;
}

function padToWidth(input: string, width: number): string {
  const visible = stripAnsi(input).length;
  if (visible >= width) return input;
  return input + " ".repeat(width - visible);
}

function stripAnsi(input: string): string {
  return input.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "");
}
