import { inspectorState, setLastReconstructed } from "../state.js";
import { buildContextItems, summarizeCounts, uniqueReadFileCount } from "../reconstruct.js";

const ANSI_CYAN = "\x1b[36m";
const ANSI_RED = "\x1b[31m";
const ANSI_RESET = "\x1b[0m";
const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;

function visibleWidth(text: string): number {
  return text.replace(ANSI_PATTERN, "").length;
}

function color(text: string, ansiColor: string): string {
  return `${ansiColor}${text}${ANSI_RESET}`;
}

function truncatePlain(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  if (width === 1) return "…";
  return `${text.slice(0, width - 1)}…`;
}

function contextWarning(ctx: any): { text: string; color: string } | undefined {
  const usage = ctx?.getContextUsage?.();
  const percent = typeof usage?.percent === "number" ? usage.percent : undefined;
  if (percent === undefined || percent <= 40) return undefined;
  if (percent > 60) return { text: "60% context exceeded, run /cnew", color: ANSI_RED };
  return { text: "> 40% context used, /tree or subagents if possible", color: ANSI_CYAN };
}

export function refreshWidget(ctx: any) {
  try {
    if (!ctx?.hasUI && ctx?.hasUI !== undefined) return;
    const items = buildContextItems(ctx, inspectorState);
    setLastReconstructed(items);
    const counts = summarizeCounts(items);
    const uniqueFiles = uniqueReadFileCount(items);
    const line = `${uniqueFiles} files read (${counts.readFile} reads)`;
    const warning = contextWarning(ctx);
    ctx.ui.setWidget("context-inspector", (_tui: any, theme: any) => ({
      render(width: number) {
        const left = theme.fg("accent", width < 34 ? `${uniqueFiles} files` : line);
        if (!warning) return [left];

        const rightText = truncatePlain(warning.text, width);
        const right = color(rightText, warning.color);
        const leftWidth = visibleWidth(left);
        const rightWidth = rightText.length;

        if (rightWidth >= width) return [right];
        if (leftWidth + 2 + rightWidth > width) {
          return [`${" ".repeat(Math.max(0, width - rightWidth))}${right}`];
        }

        return [`${left}${" ".repeat(width - leftWidth - rightWidth)}${right}`];
      },
      invalidate() {},
    }), { placement: "belowEditor" });
    ctx.ui.setStatus("context-inspector", undefined);
  } catch {
    // TUI may be unavailable in print/RPC modes; fail closed.
  }
}
