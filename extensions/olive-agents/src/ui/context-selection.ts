/**
 * ui/context-selection.ts — Human context-selection TUI used during agent
 * launch approval. Mirrors pi-telescope's floating-window overlay: split list |
 * live preview, bounded height (no overflow / flicker).
 *
 * Selectable rows are conversation MESSAGES only (user / assistant / custom);
 * tool results are intentionally excluded from the ledger. After this TUI the
 * approval flow asks a y/n compact question (native selectList) and compacts
 * the FULL conversation, not the selected rows.
 *
 * Keys: j/k move · space select · enter toggle expanded preview · alt-p/n
 * preview scroll · esc done. After this TUI the approval flow can ask the user
 * to choose one existing context, then whether to compact the conversation.
 * Nothing here mutates the session.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  selectableMessages,
} from "../context-ledger.js";

export interface ContextBuildResult {
  /** Entry ids selected (branch order preserved by the caller). */
  selectedIds: string[];
}

export interface ContextBuildInput {
  ctx: ExtensionContext;
  branch: SessionEntry[];
}

function fullTextOf(branch: SessionEntry[], entryId: string): string {
  const entry = branch.find((e) => e.id === entryId);
  if (!entry || entry.type !== "message") return "";
  const content = entry.message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === "string") return b;
        const t = (b as { type?: string; text?: string }).text;
        return (b as { type?: string }).type === "image" ? "[image]" : (t ?? "");
      })
      .join("\n");
  }
  return "";
}

/** Naive plain-text wrap (no ANSI) to preview width. */
function wrapText(text: string, width: number): string[] {
  if (width <= 2) return [];
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    if (raw.length === 0) { out.push(""); continue; }
    let line = raw;
    while (line.length > width) {
      out.push(line.slice(0, width));
      line = line.slice(width);
    }
    out.push(line);
  }
  return out;
}

function hLine(ch: string, len: number): string {
  return ch.repeat(Math.max(0, len));
}

function padRight(s: string, len: number): string {
  const vis = visibleWidth(s);
  return vis >= len ? s : s + " ".repeat(Math.max(0, len - vis));
}

/**
 * Open the context-selection TUI. Returns the built selection (undefined when
 * the user cancelled without selecting anything).
 */
export async function buildContextUI(
  input: ContextBuildInput,
): Promise<ContextBuildResult | undefined> {
  const { ctx, branch } = input;

  const messages = selectableMessages(branch);
  if (messages.length === 0) {
    ctx.ui.notify("No selectable conversation content in this session.", "warning");
    return undefined;
  }

  // Expanded preview is toggled with Enter / e.
  let expanded = false;

  return ctx.ui.custom<ContextBuildResult | undefined>((_tui, theme, _kb, done) => {
    // ── State ──
    let cursor = 0;
    let scrollOffset = 0;
    let previewScroll = 0;
    const selected = new Set<string>();

    // ── Helpers ──
    const rowAt = (i: number) => (i >= 0 && i < messages.length ? messages[i] : undefined);
    const toggleCurrent = () => {
      const r = rowAt(cursor);
      if (!r) return;
      if (selected.has(r.entryId)) selected.delete(r.entryId);
      else selected.add(r.entryId);
    };

    const selectedCount = () => selected.size;
    const selectedBytes = () => {
      let n = 0;
      for (const id of selected) n += fullTextOf(branch, id).length;
      return n;
    };

    // ── Input ──
    const handleInput = (data: string) => {
      if (matchesKey(data, Key.up) || data === "k") {
        if (cursor > 0) cursor--;
        return;
      }
      if (matchesKey(data, Key.down) || data === "j") {
        if (cursor < messages.length - 1) cursor++;
        return;
      }
      if (matchesKey(data, Key.ctrl("u"))) { cursor = Math.max(0, cursor - 10); return; }
      if (matchesKey(data, Key.ctrl("d"))) { cursor = Math.min(messages.length - 1, cursor + 10); return; }

      if (data === " ") { toggleCurrent(); return; }
      if (matchesKey(data, Key.enter)) {
        if (rowAt(cursor)) {
          expanded = !expanded;
          previewScroll = 0;
        }
        return;
      }
      if (matchesKey(data, Key.alt("p"))) { previewScroll = Math.max(0, previewScroll - 10); return; }
      if (matchesKey(data, Key.alt("n"))) { previewScroll += 10; return; }

      if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
        // Always proceed to the inherit/compact questions, even with an empty
        // selection (compact-only or inherit-only context is valid).
        done({ selectedIds: [...selected] });
      }
    };

    // ── Render (bounded-height overlay box, split list | preview) ──
    const render = (width: number): string[] => {
      const termHeight = process.stdout.rows ?? 24;
      const totalHeight = Math.min(Math.max(10, termHeight - 2), 34);
      const innerWidth = width - 2;

      const listWidth = Math.floor(innerWidth * 0.5);
      const previewWidth = innerWidth - listWidth - 1;
      const listHeight = totalHeight - 6;

      if (cursor < scrollOffset) scrollOffset = cursor;
      if (cursor >= scrollOffset + listHeight) scrollOffset = cursor - listHeight + 1;

      const bdr = (s: string) => theme.fg("border", s);
      const acc = (s: string) => theme.fg("accent", s);
      const dim = (s: string) => theme.fg("dim", s);
      const lines: string[] = [];

      // ── Top border ──
      lines.push(bdr(`╭${hLine("─", innerWidth)}╮`));

      // ── Header: title ──
      const header = `${acc(theme.bold("Select context for sendoff"))}  ${dim(`messages ${messages.length}`)}`;
      lines.push(bdr("│") + " " + truncateToWidth(header, innerWidth - 2) + " " + bdr("│"));

      // ── Status row: selection count ──
      const count = selectedCount();
      const size = count > 0 ? ` · ~${Math.max(1, Math.round(selectedBytes() / 1024))}KB` : "";
      const selText = count === 0 ? dim("no items selected") : theme.fg("success", `${count} selected${size}`);
      const status = `${selText}   ${dim("next: existing context? → compact?")}`;
      lines.push(bdr("│") + " " + truncateToWidth(status, innerWidth - 2) + " " + bdr("│"));

      // ── Separator ──
      lines.push(bdr(`├${hLine("─", listWidth)}┬${hLine("─", previewWidth)}┤`));

      // ── List + preview rows ──
      const active = rowAt(cursor);
      const previewText = active ? fullTextOf(branch, active.entryId) : "";
      const previewLines = wrapText(previewText, previewWidth - 2);

      for (let r = 0; r < listHeight; r++) {
        let leftCell = "";
        const idx = scrollOffset + r;
        const item = rowAt(idx);
        if (item) {
          const isCursor = idx === cursor;
          const isSel = selected.has(item.entryId);
          const cursorMark = isCursor ? acc("›") : " ";
          const check = isSel ? theme.fg("success", "●") : dim("·");
          const label = item.label;
          // Prefix is cursorMark + check + separating space (3 visible chars);
          // subtract it so a truncated label still fits the padded cell width.
          leftCell = `${cursorMark}${check} ${truncateToWidth(isCursor ? theme.bold(label) : label, listWidth - 5, "…")}`;
        }
        leftCell = " " + padRight(leftCell, listWidth - 2) + " ";

        let rightCell = "";
        const pid = previewScroll + r;
        if (pid < previewLines.length) {
          const line = previewLines[pid] ?? "";
          rightCell = truncateToWidth(expanded ? line : line.slice(0, previewWidth - 2), previewWidth - 2, "…");
        }
        rightCell = " " + padRight(rightCell, previewWidth - 2) + " ";

        lines.push(bdr("│") + leftCell + bdr("│") + rightCell + bdr("│"));
      }

      // ── Separator ──
      lines.push(bdr(`├${hLine("─", listWidth)}┴${hLine("─", previewWidth)}┤`));

      // ── Hints row ──
      const hints = [
        acc("j/k") + dim(" move"),
        acc("space") + dim(" select"),
        acc("enter") + dim(" preview"),
        acc("esc") + dim(" done → existing context?"),
      ].join(dim("  ·  "));
      lines.push(bdr("│") + " " + truncateToWidth(hints, innerWidth - 2) + " " + bdr("│"));

      // ── Bottom border ──
      lines.push(bdr(`╰${hLine("─", innerWidth)}╯`));

      return lines;
    };

    return {
      render,
      invalidate: () => {},
      handleInput,
    };
  }, {
    overlay: true,
    overlayOptions: {
      anchor: "top-center" as const,
      offsetY: 1,
      width: "95%",
      minWidth: 80,
      maxHeight: "85%",
    },
  });
}