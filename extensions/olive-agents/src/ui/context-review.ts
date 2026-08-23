/**
 * ui/context-review.ts — Human review of the prepared context packet.
 *
 * Drill-down follows the existing approval-TUI conventions:
 *   approval list → Review context → item list → exact content.
 *
 * The review renders inline in the editor area (no floating overlay), the
 * same way the approval `ctx.ui.select` list is shown, and reuses SelectList
 * with the configured `tui.select.*` keybindings (vim and arrow keys). The
 * item list renders a CONSTANT number of lines (title, summary, at most one
 * warning line, at most one packet-problem line, the attention note, the item
 * viewport padded to full height, and the hint), with every line truncated to
 * the terminal width. A packet therefore can never shift or flicker the view
 * as items are removed — matching the no-resize rule of the approval modal.
 * Item content opens in `ctx.ui.editor` as a view-only text (edits discarded), the same mechanism as "View inherited context".
 *
 * Selection survives a view/back round-trip: the viewed item id is remembered
 * and restored when the list is re-entered.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getKeybindings, SelectList, truncateToWidth } from "@earendil-works/pi-tui";
import { reducePreparedContext } from "../handoff/prepare.js";
import {
  isContextHandoffEmpty,
  type ContextProblem,
  type PreparedContextHandoff,
} from "../handoff/types.js";

export interface ContextReviewOutcome {
  /** The possibly-reduced packet, or `undefined` when every item was removed. */
  prepared: PreparedContextHandoff | undefined;
  /** True when the human cancelled the whole approval from inside the review. */
  cancelled: boolean;
}

interface ReviewActions {
  view: (id: string) => void;
  remove: (id: string) => void;
  back: () => void;
}

interface ReviewItem {
  id: string;
  label: string;
  description?: string;
}

const MAX_VISIBLE_ITEMS = 12;
/** Total rendered line count — constant regardless of packet contents. */
const FIXED_HEIGHT = 20;

/** Enter the review loop. Returns an outcome the approval modal applies. */
export async function reviewContextHandoff(
  ctx: ExtensionContext,
  initial: PreparedContextHandoff,
): Promise<ContextReviewOutcome> {
  let current = initial;
  let selectedId: string | undefined;
  for (;;) {
    const outcome = await ctx.ui.custom<
      { kind: "view"; id: string } | { kind: "remove"; id: string } | { kind: "back" }
    >(
      (_tui, theme, _keybindings, done) => {
        const actions: ReviewActions = {
          view: (id) => done({ kind: "view", id }),
          remove: (id) => done({ kind: "remove", id }),
          back: () => done({ kind: "back" }),
        };
        return new ContextReviewList(current, actions, theme, selectedId);
      },
    );
    if (!outcome) return { prepared: current, cancelled: true };

    switch (outcome.kind) {
      case "back":
        return { prepared: current, cancelled: false };
      case "remove": {
        current = reducePreparedContext(current, new Set([outcome.id]));
        if (isContextHandoffEmpty(current)) {
          return { prepared: undefined, cancelled: false };
        }
        continue;
      }
      case "view": {
        const viewed = await showItemView(ctx, current, outcome.id);
        if (viewed) selectedId = outcome.id;
        // Unknown id (removed concurrently) — just re-render the list.
        continue;
      }
    }
  }
}

/** Fixed-height context item selector with removal and selection restore. */
export class ContextReviewList {
  private items: ReviewItem[];
  private list: SelectList;
  private selected = 0;

  constructor(
    private prepared: PreparedContextHandoff,
    private actions: ReviewActions,
    private theme: { fg: (color: string, text: string) => string; bold: (text: string) => string },
    preferredId?: string,
  ) {
    this.items = buildReviewItems(prepared);
    this.list = new SelectList(
      this.items.map((item) => ({ value: item.id, label: item.label, description: item.description })),
      MAX_VISIBLE_ITEMS,
      {
        selectedPrefix: (text) => theme.fg("accent", text),
        selectedText: (text) => theme.fg("accent", text),
        description: (text) => theme.fg("dim", text),
        scrollInfo: (text) => theme.fg("muted", text),
        noMatch: (text) => theme.fg("muted", text),
      },
    );
    const preferredIndex = preferredId
      ? this.items.findIndex((item) => item.id === preferredId)
      : -1;
    this.selected = preferredIndex >= 0 ? preferredIndex : 0;
    this.list.setSelectedIndex(this.selected);
    this.list.onSelect = (item) => this.actions.view(item.value);
    this.list.onCancel = () => this.actions.back();
  }

  /** Public selection index (tests, UI state). */
  getSelectedIndex(): number {
    return this.selected;
  }

  handleInput(data: string): void {
    if (data === "d" || data === "D") {
      const item = this.list.getSelectedItem();
      if (item) this.actions.remove(item.value);
      return;
    }
    // Mirror the approval selector's navigation exactly: raw vim j/k plus the
    // configured tui.select up/down, clamped at the ends. SelectList itself
    // only binds the configured keys (no raw j/k), so we intercept both.
    const kb = getKeybindings();
    if (data === "k" || kb.matches(data, "tui.select.up")) {
      this.moveSelection(-1);
      return;
    }
    if (data === "j" || kb.matches(data, "tui.select.down")) {
      this.moveSelection(1);
      return;
    }
    // Enter / Esc and everything else are owned by SelectList.
    this.list.handleInput(data);
  }

  /** Clamp-selected move, synced into the SelectList. */
  private moveSelection(delta: number): void {
    const count = this.items.length;
    if (count === 0) return;
    const next = Math.max(0, Math.min(count - 1, this.selected + delta));
    if (next === this.selected) return;
    this.selected = next;
    this.list.setSelectedIndex(next);
  }

  invalidate(): void {
    this.list.invalidate();
  }

  render(width: number): string[] {
    const t = this.theme;
    const p = this.prepared;
    const problems = p.snippetProblems.length + p.leadProblems.length + p.packetProblems.length;

    const lines: string[] = [
      t.fg("accent", t.bold("Review context packet")),
      t.fg(
        "muted",
        `Est. ${p.estimatedTokens} tokens · ${p.totalBytes} bytes · ${p.snippets.length} evidence snippet(s) · ${p.recommendedFiles.length} recommended file(s)`,
      ),
      p.warnings.length > 0 ? t.fg("warning", `warnings: ${p.warnings.join("; ")}`) : "",
      p.packetProblems[0]
        ? t.fg("error", `⚠ ${p.packetProblems[0].message}${p.packetProblems.length > 1 ? ` (+${p.packetProblems.length - 1} more)` : ""}`)
        : "",
      problems > 0 ? t.fg("error", "⚠ Launch will send feedback to the main agent until the problems are removed.") : "",
      "",
      ...this.list.render(Math.max(8, width - 2)),
      "",
      t.fg("dim", "↑/↓ j/k move · Enter view exact content · d remove · Esc back"),
    ];

    while (lines.length < FIXED_HEIGHT) lines.push("");
    return lines.slice(0, FIXED_HEIGHT).map((line) => truncateToWidth(line, Math.max(1, width), "…"));
  }
}

/** Open the exact content / description for one item in a view-only editor. */
async function showItemView(
  ctx: ExtensionContext,
  prepared: PreparedContextHandoff,
  id: string,
): Promise<boolean> {
  const snippet = prepared.snippets.find((s) => s.id === id);
  if (snippet) {
    await ctx.ui.editor(
      `Snippet — ${snippet.path}:${snippet.startLine}-${snippet.endLine} · view only (edits discarded)`,
      snippet.content,
    );
    return true;
  }
  const lead = prepared.recommendedFiles.find((l) => l.id === id);
  if (lead) {
    await ctx.ui.editor(
      `Recommended file — ${lead.path} · view only (edits discarded)`,
      [
        `Path: ${lead.path}`,
        lead.symbol ? `Symbol: ${lead.symbol}` : "",
        lead.reason ? `Reason: ${lead.reason}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
    return true;
  }
  const problem = [...prepared.snippetProblems, ...prepared.leadProblems].find((p) => p.id === id);
  if (problem) {
    await ctx.ui.editor(`Context problem — ${problem.kind} · view only`, problem.message);
    return true;
  }
  return false;
}

function buildReviewItems(prepared: PreparedContextHandoff): ReviewItem[] {
  const items: ReviewItem[] = [];
  for (const snippet of prepared.snippets) {
    items.push({
      id: snippet.id,
      label: `${snippet.path}:${snippet.startLine}-${snippet.endLine}`,
      description: `est. ${snippet.estimatedTokens} tokens${snippet.reason ? ` — ${snippet.reason}` : ""}`,
    });
  }
  for (const problem of prepared.snippetProblems) {
    items.push({
      id: problem.id,
      label: `⚠ ${problem.snippet ? `${problem.snippet.path}:${problem.snippet.startLine}-${problem.snippet.endLine}` : "snippet"}`,
      description: `${problem.kind} — ${firstLine(problem.message)}`,
    });
  }
  for (const lead of prepared.recommendedFiles) {
    items.push({
      id: lead.id,
      label: `${lead.path}${lead.symbol ? ` [${lead.symbol}]` : ""}`,
      description: lead.reason,
    });
  }
  for (const problem of prepared.leadProblems) {
    items.push({
      id: problem.id,
      label: `⚠ ${problem.lead ? problem.lead.path : "recommended file"}`,
      description: `${problem.kind} — ${firstLine(problem.message)}`,
    });
  }
  return items;
}

function firstLine(text: string): string {
  const first = text.split("\n")[0] ?? "";
  return first.length > 120 ? `${first.slice(0, 117)}…` : first;
}