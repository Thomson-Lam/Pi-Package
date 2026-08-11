import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { inspectorState, setLastReconstructed } from "../state.js";
import { buildContextItems, contentToText } from "../reconstruct.js";
import type { ContextItem } from "../types.js";
import { refreshWidget } from "./widget.js";

interface UsageBucket {
  key: string;
  label: string;
  glyph: string;
  color: "accent" | "warning" | "error" | "success" | "muted" | "dim";
  tokens: number;
  details?: string;
}

interface UsageSnapshot {
  tokens?: number;
  contextWindow?: number;
  percent?: number;
  buckets: UsageBucket[];
  reservedTokens: number;
  freeTokens?: number;
}

export async function openContextUsagePanel(ctx: ExtensionContext) {
  if (!(ctx as any).hasUI && (ctx as any).hasUI !== undefined) {
    ctx.ui.notify("Context usage needs interactive UI.", "warning");
    return;
  }

  rebuild(ctx);

  await ctx.ui.custom<void>((tui: any, theme: any, _keybindings: any, done: (value: void) => void) => {
    return new ContextUsagePanel(ctx, tui, theme, done);
  }, {
    overlay: true,
    overlayOptions: {
      width: "74%",
      minWidth: 62,
      maxHeight: "86%",
      anchor: "center",
      visible: (termWidth: number) => termWidth >= 80,
    },
  });

  refreshWidget(ctx);
}

function rebuild(ctx: any): ContextItem[] {
  const items = buildContextItems(ctx, inspectorState);
  setLastReconstructed(items);
  return items;
}

class ContextUsagePanel {
  constructor(
    private ctx: any,
    private tui: any,
    private theme: any,
    private done: (value: void) => void,
  ) {}

  render(width: number): string[] {
    rebuild(this.ctx);
    const innerWidth = Math.max(10, width - 2);
    const snapshot = buildUsageSnapshot(this.ctx, inspectorState.lastReconstructed);
    const lines: string[] = [];

    lines.push(this.fit(innerWidth, this.titleLine(snapshot)));
    lines.push("");
    this.renderGrid(lines, innerWidth, snapshot);
    lines.push("");
    this.renderLegend(lines, innerWidth, snapshot);
    lines.push("");
    this.renderDetails(lines, innerWidth, snapshot);
    lines.push("");
    lines.push(this.fit(innerWidth, this.theme.fg("dim", "r refresh • /reads inspect read snapshots • esc close")));

    const top = this.theme.fg("borderAccent", `┌${"─".repeat(innerWidth)}┐`);
    const bottom = this.theme.fg("borderAccent", `└${"─".repeat(innerWidth)}┘`);
    return [
      top,
      ...lines.map((line) => this.theme.fg("borderAccent", "│") + padToWidth(this.fit(innerWidth, line), innerWidth) + this.theme.fg("borderAccent", "│")),
      bottom,
    ];
  }

  handleInput(data: string): void {
    if (isKey(data, "escape") || isKey(data, "ctrl+c")) {
      this.done();
      return;
    }
    if (data === "r" || data === "R") {
      rebuild(this.ctx);
      this.tui.requestRender();
    }
  }

  invalidate(): void {}

  private titleLine(snapshot: UsageSnapshot): string {
    const used = snapshot.tokens !== undefined ? formatTokens(snapshot.tokens) : "?";
    const total = snapshot.contextWindow !== undefined ? formatTokens(snapshot.contextWindow) : "?";
    const pct = snapshot.percent !== undefined ? `${snapshot.percent.toFixed(1)}%` : "?";
    const color = snapshot.percent !== undefined && snapshot.percent > 60
      ? "error"
      : snapshot.percent !== undefined && snapshot.percent > 40
        ? "warning"
        : "accent";
    return this.theme.fg("accent", this.theme.bold("Context Usage ")) + this.theme.fg(color, `${used}/${total} tokens (${pct})`);
  }

  private renderGrid(lines: string[], width: number, snapshot: UsageSnapshot) {
    const cells = 100;
    const contextWindow = snapshot.contextWindow || 0;
    const usedTokens = snapshot.tokens || 0;
    const reservedTokens = snapshot.reservedTokens || 0;
    const usedCells = contextWindow > 0 ? Math.round((usedTokens / contextWindow) * cells) : 0;
    const reservedCells = contextWindow > 0 ? Math.round((reservedTokens / contextWindow) * cells) : 0;

    const bucketCells = allocateBucketCells(snapshot.buckets, Math.max(0, Math.min(cells, usedCells)));
    const grid: string[] = [];
    for (const bucket of snapshot.buckets) {
      const count = bucketCells.get(bucket.key) ?? 0;
      for (let i = 0; i < count; i++) grid.push(this.theme.fg(bucket.color, bucket.glyph));
    }
    while (grid.length < Math.min(cells, usedCells)) grid.push(this.theme.fg("accent", "■"));
    for (let i = 0; i < reservedCells && grid.length < cells; i++) grid.push(this.theme.fg("warning", "▣"));
    while (grid.length < cells) grid.push(this.theme.fg("dim", "□"));

    const cols = width >= 74 ? 20 : 10;
    for (let i = 0; i < cells; i += cols) {
      lines.push(this.fit(width, `  ${grid.slice(i, i + cols).join(" ")}`));
    }
  }

  private renderLegend(lines: string[], width: number, snapshot: UsageSnapshot) {
    const total = snapshot.contextWindow || 0;
    for (const bucket of snapshot.buckets.filter((b) => b.tokens > 0)) {
      lines.push(this.fit(width, legendLine(this.theme, bucket, total)));
    }
    if (snapshot.reservedTokens > 0) {
      lines.push(this.fit(width, `${this.theme.fg("warning", "▣")} Reserved: ${formatTokens(snapshot.reservedTokens)} tokens${total ? ` (${pct(snapshot.reservedTokens, total)})` : ""} ${this.theme.fg("dim", "[output + compaction buffer estimate]")}`));
    }
    if (snapshot.freeTokens !== undefined) {
      lines.push(this.fit(width, `${this.theme.fg("dim", "□")} Free space: ${formatTokens(snapshot.freeTokens)}${total ? ` (${pct(snapshot.freeTokens, total)})` : ""}`));
    }
  }

  private renderDetails(lines: string[], width: number, snapshot: UsageSnapshot) {
    const items = inspectorState.lastReconstructed;
    const readFiles = new Set(items.filter((i) => i.type === "readFile" && i.path).map((i) => i.path));
    const contextFiles = items.filter((i) => i.type === "contextFile");
    const summaries = items.filter((i) => i.type === "compactionSummary" || i.type === "branchSummary");

    lines.push(this.fit(width, this.theme.fg("accent", this.theme.bold("Context sources"))));
    lines.push(this.fit(width, `  Context files: ${contextFiles.length}`));
    lines.push(this.fit(width, `  Read snapshots: ${items.filter((i) => i.type === "readFile").length} (${readFiles.size} unique files)`));
    lines.push(this.fit(width, `  Summaries/compactions: ${summaries.length}`));
    const unknown = snapshot.tokens === undefined ? this.theme.fg("warning", "Pi has not reported context usage for this session/model yet.") : undefined;
    if (unknown) lines.push(this.fit(width, `  ${unknown}`));
  }

  private fit(width: number, line: string): string {
    return truncateToWidth(line, width, "…");
  }
}

function buildUsageSnapshot(ctx: any, items: ContextItem[]): UsageSnapshot {
  const usage = ctx?.getContextUsage?.();
  const tokens = typeof usage?.tokens === "number" ? usage.tokens : undefined;
  const contextWindow = typeof usage?.contextWindow === "number" ? usage.contextWindow : ctx?.model?.contextWindow;
  const percent = typeof usage?.percent === "number" ? usage.percent : tokens && contextWindow ? (tokens / contextWindow) * 100 : undefined;

  const branch = safeGetBranch(ctx);
  const systemPromptTokens = estimateTokens(inspectorState.lastSystemPrompt ?? ctx?.getSystemPrompt?.() ?? "");
  const contextFileTokens = sumTokens(items.filter((i) => i.type === "contextFile"));
  const readTokens = sumTokens(items.filter((i) => i.type === "readFile"));
  const summaryTokens = sumTokens(items.filter((i) => i.type === "compactionSummary" || i.type === "branchSummary"));
  const messageTokens = estimateMessageTokens(branch);
  const toolTokens = estimateToolTokens(ctx);

  const buckets: UsageBucket[] = [
    { key: "system", label: "System prompt", glyph: "●", color: "muted", tokens: systemPromptTokens },
    { key: "tools", label: "System tools", glyph: "●", color: "accent", tokens: toolTokens, details: "rough estimate from active tool definitions when available" },
    { key: "context", label: "Context files", glyph: "■", color: "success", tokens: contextFileTokens },
    { key: "reads", label: "Read snapshots", glyph: "■", color: "accent", tokens: readTokens },
    { key: "summaries", label: "Summaries", glyph: "■", color: "warning", tokens: summaryTokens },
    { key: "messages", label: "Messages", glyph: "■", color: "error", tokens: messageTokens },
  ];

  const reservedTokens = contextWindow ? Math.min(contextWindow, Math.max(16_384, Math.round(contextWindow * 0.12))) : 0;
  const freeTokens = contextWindow !== undefined && tokens !== undefined ? Math.max(0, contextWindow - tokens - reservedTokens) : undefined;

  return { tokens, contextWindow, percent, buckets, reservedTokens, freeTokens };
}

function sumTokens(items: ContextItem[]): number {
  return items.reduce((sum, item) => sum + estimateTokens([item.title, item.preview, item.contentText].filter(Boolean).join("\n")), 0);
}

function estimateMessageTokens(branch: any[]): number {
  let text = "";
  for (const entry of branch) {
    const msg = entry?.type === "message" ? entry.message : undefined;
    if (!msg || msg.role === "toolResult") continue;
    text += `\n${msg.role}: ${contentToText(msg.content)}`;
  }
  return estimateTokens(text);
}

function estimateToolTokens(ctx: any): number {
  const tools = ctx?.tools ?? ctx?.toolManager?.tools ?? ctx?.toolsManager?.tools;
  if (!tools) return 0;
  try {
    return estimateTokens(JSON.stringify(tools));
  } catch {
    return 0;
  }
}

function estimateTokens(text: string): number {
  const normalized = String(text ?? "").trim();
  if (!normalized) return 0;
  return Math.max(1, Math.ceil(normalized.length / 4));
}

function allocateBucketCells(buckets: UsageBucket[], usedCells: number): Map<string, number> {
  const result = new Map<string, number>();
  const total = buckets.reduce((sum, b) => sum + b.tokens, 0);
  if (!total || usedCells <= 0) return result;
  let allocated = 0;
  for (const bucket of buckets) {
    const cells = bucket.tokens > 0 ? Math.max(1, Math.round((bucket.tokens / total) * usedCells)) : 0;
    result.set(bucket.key, cells);
    allocated += cells;
  }
  while (allocated > usedCells) {
    const candidate = [...result.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])[0];
    if (!candidate) break;
    result.set(candidate[0], candidate[1] - 1);
    allocated--;
  }
  return result;
}

function legendLine(theme: any, bucket: UsageBucket, total: number): string {
  const extra = bucket.details ? ` ${theme.fg("dim", `[${bucket.details}]`)}` : "";
  return `${theme.fg(bucket.color, bucket.glyph)} ${bucket.label}: ${formatTokens(bucket.tokens)} tokens${total ? ` (${pct(bucket.tokens, total)})` : ""}${extra}`;
}

function pct(value: number, total: number): string {
  if (!total) return "0.0%";
  return `${((value / total) * 100).toFixed(1)}%`;
}

function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

function safeGetBranch(ctx: any): any[] {
  try {
    const branch = ctx?.sessionManager?.getBranch?.();
    return Array.isArray(branch) ? branch : [];
  } catch {
    return [];
  }
}

function isKey(data: string, key: "escape" | "ctrl+c"): boolean {
  const map: Record<typeof key, string[]> = {
    escape: ["\u001b"],
    "ctrl+c": ["\u0003"],
  };
  return map[key].includes(data);
}

function truncateToWidth(input: string, width: number, ellipsis = "…"): string {
  if (width <= 0) return "";
  const plain = stripAnsi(input);
  if (plain.length <= width) return input;
  const target = Math.max(0, width - ellipsis.length);
  return plain.slice(0, target) + ellipsis;
}

function padToWidth(input: string, width: number): string {
  const visible = stripAnsi(input).length;
  if (visible >= width) return input;
  return input + " ".repeat(width - visible);
}

function stripAnsi(input: string): string {
  return input.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "");
}
