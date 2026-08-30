/**
 * ui/context-tree.ts — /ot TUI. Inspects the persisted context-ledger tree and
 * routes the user to agent sessions. Mirrors pi-telescope's floating-window
 * overlay: split list|preview, bounded height (no overflow / flicker).
 *
 * States:
 *   browse   tree rows left, node/session preview right
 *            j/k move · h parent (only when an upstream parent exists) ·
 *            enter actions · esc close
 *   menu     per-row actions (launch / view context / focus / open / cancel)
 *   context  read-only detail of a ledger node (alt-p/n scroll, esc back)
 *
 * The "Launch agent with this context" action closes the TUI and resolves with
 * `launch:<sessionFile>`; the caller runs the standard ledger+compaction flow
 * pre-seeded with that node's chain. Other actions stay in-TUI.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  type ContextLedgerNode,
  type LedgerGraph,
  type TreeRow,
  computeTreeRows,
  nodeToMarkdown,
} from "../context-ledger.js";

export interface ContextTreeInput {
  ctx: ExtensionContext;
  graph: LedgerGraph;
  /** Root→leaf session files (leaf = the /ot-invoking session). */
  ancestorFiles: string[];
  currentFile: string;
  currentLedgerId?: string;
  /** Route the user to a session pane: focus it if live, else open it. */
  focusOrOpen(row: TreeRow): Promise<void>;
  /**
   * "navigate" = /ot browse (default). "select" = inheritance picker: ledger
   * rows are toggled with Space into `selected`, Enter/Esc closes and resolves
   * undefined (the caller reads `selected`). No action menu in select mode.
   */
  mode?: "navigate" | "select";
  /** Select mode: live set of toggled ledger node ids (may be pre-seeded). */
  selected?: Set<string>;
}

type UiState =
  | { kind: "browse" }
  | { kind: "menu"; cursor: number; actions: string[] }
  | { kind: "context"; title: string; lines: string[]; scroll: number };

const CANCEL = "Cancel";

function hLine(ch: string, len: number): string {
  return ch.repeat(Math.max(0, len));
}

function padRight(s: string, len: number): string {
  const vis = visibleWidth(s);
  return vis >= len ? s : s + " ".repeat(Math.max(0, len - vis));
}

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

export async function openContextTree(input: ContextTreeInput): Promise<string | undefined> {
  const { ctx, graph, ancestorFiles, currentFile, currentLedgerId, focusOrOpen } = input;
  // viewIndex: position in ancestorFiles of the row root. Starts at the leaf
  // (the current session); h moves it toward the root.
  let viewIndex = Math.max(0, ancestorFiles.length - 1);
  let state: UiState = { kind: "browse" };
  let cursor = 0;

  const viewRootFile = () => ancestorFiles[viewIndex] ?? currentFile;
  const hasParent = () => viewIndex > 0;
  const isSelect = input.mode === "select";
  const selected = input.selected ?? new Set<string>();

  const rows = (): TreeRow[] =>
    computeTreeRows(graph, viewRootFile(), currentFile, currentLedgerId);

  const actionsFor = (row: TreeRow): string[] => {
    if (row.kind === "ledger") return ["Launch agent with this context", "View context passed", "Focus agent pane", "Open agent session", CANCEL];
    if (row.kind === "isolated") return ["Focus agent pane", "Open agent session", CANCEL];
    return [CANCEL];
  };

  const contextLines = (row: TreeRow): { title: string; lines: string[] } => {
    const node = row.node;
    if (!node) return { title: row.label, lines: ["(no ledger node — isolated session)"] };
    const lines: string[] = [];
    lines.push(`Source: ${node.sourceSessionName}${node.sourceSessionFile ? ` · ${node.sourceSessionFile}` : ""}`);
    lines.push(`Ledger id: ${node.id}`);
    lines.push(`Created: ${node.createdAt}`);
    if (node.parentId) lines.push(`Parent ledger: ${node.parentId}`);
    const chain: string[] = [];
    let cur: ContextLedgerNode | undefined = node;
    while (cur?.parentId) {
      const parent = graph.nodes.get(cur.parentId);
      if (!parent) {
        chain.push(`(unknown ancestor ${cur.parentId})`);
        break;
      }
      chain.unshift(parent.sourceSessionName);
      cur = parent;
    }
    if (chain.length) {
      lines.push("");
      lines.push("Inherited chain (root→leaf):");
      for (const name of chain) lines.push(`  · ${name}`);
    }
    const md = nodeToMarkdown(node);
    if (md) {
      lines.push("");
      lines.push(...md.split("\n"));
    } else {
      lines.push("", "(no context content selected)");
    }
    return { title: row.label, lines };
  };

  return ctx.ui.custom<string | undefined>((_tui, theme, _kb, done) => {
    // ── Render (bounded-height overlay box, split list | preview) ──
    const render = (width: number): string[] => {
      const termHeight = process.stdout.rows ?? 24;
      const totalHeight = Math.min(Math.max(10, termHeight - 2), 34);
      const innerWidth = width - 2;

      const bdr = (s: string) => theme.fg("border", s);
      const acc = (s: string) => theme.fg("accent", s);
      const dim = (s: string) => theme.fg("dim", s);

      if (state.kind === "context") {
        // Full-width detail panel inside the same box.
        const listHeight = totalHeight - 4;
        const sc = state.scroll;
        const body = wrapText(state.lines.join("\n"), innerWidth - 4);
        const head = acc(theme.bold(state.title));
        const lines: string[] = [bdr(`╭${hLine("─", innerWidth)}╮`)];
        lines.push(bdr("│") + " " + truncateToWidth(head, innerWidth - 2) + " " + bdr("│"));
        lines.push(bdr(`├${hLine("─", innerWidth)}┤`));
        for (let r = 0; r < listHeight; r++) {
          const idx = sc + r;
          const content = idx < body.length ? truncateToWidth(body[idx] ?? "", innerWidth - 4, "…") : "";
          lines.push(bdr("│") + "  " + padRight(content, innerWidth - 4) + "  " + bdr("│"));
        }
        lines.push(bdr(`├${hLine("─", innerWidth)}┤`));
        lines.push(bdr("│") + " " + dim(`alt-p/n scroll · esc back   ${body.length > 0 ? `${state.scroll + 1}–${Math.min(state.scroll + listHeight, body.length)}/${body.length}` : ""}`) + " " + bdr("│"));
        lines.push(bdr(`╰${hLine("─", innerWidth)}╯`));
        return lines;
      }

      const listWidth = Math.floor(innerWidth * 0.55);
      const previewWidth = innerWidth - listWidth - 1;
      const listHeight = totalHeight - 5;

      const list = rows();
      const menuRows = !isSelect && state.kind === "menu" ? state.actions : undefined;

      // Ensure selection visible in the left column.
      const leftLen = menuRows?.length ?? list.length;
      const selIdx = menuRows ? (state as Extract<UiState, { kind: "menu" }>).cursor : cursor;
      let scroll = 0;
      if (selIdx < scroll) scroll = selIdx;
      if (selIdx >= scroll + listHeight) scroll = selIdx - listHeight + 1;

      // Right-column preview: context of the highlighted ledger row.
      const activeRow = list[Math.min(cursor, Math.max(0, list.length - 1))];
      const previewBody = activeRow?.node
        ? nodeToMarkdown(activeRow.node)
        : activeRow?.kind === "isolated"
          ? "(no ledger node — session launched without context)"
          : "(session row)";
      const previewLines = wrapText(previewBody, previewWidth - 2);

      const lines: string[] = [bdr(`╭${hLine("─", innerWidth)}╮`)];
      lines.push(bdr("│") + " " + truncateToWidth(acc(theme.bold("Context tree")), innerWidth - 2) + " " + bdr("│"));

      // Status row: highlighted row + (select mode) toggled count.
      const statusParts: string[] = [];
      if (activeRow) statusParts.push(dim(`sel ${activeRow.number} ${activeRow.label}`));
      if (isSelect) statusParts.push(acc(`${selected.size} inherited`));
      lines.push(bdr("│") + " " + truncateToWidth(statusParts.join("   "), innerWidth - 2) + " " + bdr("│"));
      lines.push(bdr(`├${hLine("─", listWidth)}┬${hLine("─", previewWidth)}┤`));

      for (let r = 0; r < listHeight; r++) {
        let leftCell = "";
        const idx = scroll + r;
        if (menuRows) {
          const action = menuRows[idx];
          if (action) {
            const isSel = idx === selIdx;
            const mark = isSel ? acc("›") : " ";
            leftCell = `${mark} ${truncateToWidth(isSel ? theme.bold(action) : action, listWidth - 4, "…")}`;
          }
        } else {
          const row = list[idx];
          if (row) {
            const isSel = idx === cursor;
            const mark = isSel ? acc("›") : " ";
            let toggle = "";
            if (isSelect && row.node) {
              toggle = selected.has(row.node.id) ? theme.fg("success", "● ") : dim("· ");
            }
            const num = dim(row.number.padEnd(9));
            const name = row.isCurrent ? acc(row.label) : row.kind === "isolated" ? theme.fg("muted", row.label) : row.label;
            const prefix = "  ".repeat(row.indent);
            leftCell = `${mark}${toggle}${prefix}${num}${isSel ? theme.bold(name) : name}`;
          }
        }
        leftCell = " " + padRight(truncateToWidth(leftCell, listWidth - 2, "…"), listWidth - 2) + " ";

        let rightCell = "";
        const pid = r;
        if (pid < previewLines.length) {
          rightCell = truncateToWidth(previewLines[pid] ?? "", previewWidth - 2, "…");
        }
        rightCell = " " + padRight(rightCell, previewWidth - 2) + " ";

        lines.push(bdr("│") + leftCell + bdr("│") + rightCell + bdr("│"));
      }

      lines.push(bdr(`├${hLine("─", listWidth)}┴${hLine("─", previewWidth)}┤`));

      // Hints row.
      const hints: string[] = [acc("j/k") + dim(" move")];
      if (isSelect) {
        if (state.kind === "browse") {
          if (hasParent()) hints.push(acc("h") + dim(" parent"));
          hints.push(acc("space") + dim(" toggle inherit"));
          hints.push(acc("esc") + dim(" done → compact?"));
        }
      } else if (state.kind === "browse") {
        // /ot browse (cyan h parent only when an upstream parent exists).
        if (hasParent()) hints.push(acc("h") + dim(" parent"));
        hints.push(acc("enter") + dim(" actions"));
        hints.push(acc("esc") + dim(" close"));
      } else if (state.kind === "menu") {
        hints.push(acc("enter") + dim(" run"));
        hints.push(acc("esc") + dim(" back"));
      }
      lines.push(bdr("│") + " " + truncateToWidth(hints.join(dim("  ·  ")), innerWidth - 2) + " " + bdr("│"));
      lines.push(bdr(`╰${hLine("─", innerWidth)}╯`));
      return lines;
    };

    // ── Input ──
    const handleInput = (data: string) => {
      if (state.kind === "context") {
        if (matchesKey(data, Key.alt("p"))) { state.scroll = Math.max(0, state.scroll - 10); }
        else if (matchesKey(data, Key.alt("n"))) { state.scroll += 10; }
        else if (matchesKey(data, Key.escape) || data === "q") {
          state = { kind: "browse" };
        }
        return;
      }

      if (state.kind === "menu") {
        if (matchesKey(data, Key.up) || data === "k") {
          if (state.cursor > 0) state.cursor--;
          return;
        }
        if (matchesKey(data, Key.down) || data === "j") {
          if (state.cursor < state.actions.length - 1) state.cursor++;
          return;
        }
        if (matchesKey(data, Key.escape) || data === "q" || data === "h" || data === "H") {
          state = { kind: "browse" };
          return;
        }
        if (matchesKey(data, Key.enter)) {
          const action = state.actions[state.cursor];
          const row = rows()[cursor];
          if (!row) return;
          if (action === CANCEL) { state = { kind: "browse" }; return; }
          if (action === "Launch agent with this context") {
            done(row.sessionFile ? `launch:${row.sessionFile}` : undefined);
            return;
          }
          if (action === "View context passed") {
            const { title, lines } = contextLines(row);
            state = { kind: "context", title, lines, scroll: 0 };
            return;
          }
          if (action === "Focus agent pane" || action === "Open agent session") {
            void focusOrOpen(row).finally(() => { state = { kind: "browse" }; });
            return;
          }
        }
        return;
      }

      // browse
      if (matchesKey(data, Key.up) || data === "k") {
        cursor = Math.max(0, cursor - 1);
        return;
      }
      if (matchesKey(data, Key.down) || data === "j") {
        cursor = Math.min(rows().length - 1, cursor + 1);
        return;
      }
      if (data === "h" || data === "H") {
        if (hasParent()) {
          viewIndex--;
          cursor = 0;
        }
        return;
      }
      if (isSelect) {
        if (data === " ") {
          const row = rows()[cursor];
          if (row?.node) {
            if (selected.has(row.node.id)) selected.delete(row.node.id);
            else selected.add(row.node.id);
          }
          return;
        }
        if (matchesKey(data, Key.enter) || matchesKey(data, Key.escape) || data === "q" || matchesKey(data, Key.ctrl("c"))) {
          done(undefined); // caller reads input.selected
          return;
        }
        return;
      }
      if (matchesKey(data, Key.enter)) {
        const row = rows()[cursor];
        if (!row) return;
        state = { kind: "menu", cursor: 0, actions: actionsFor(row) };
        return;
      }
      if (matchesKey(data, Key.escape) || data === "q" || matchesKey(data, Key.ctrl("c"))) {
        done();
      }
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