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
  /** Root→leaf session files (leaf = the invoking session). */
  ancestorFiles: string[];
  currentFile: string;
  currentLedgerId?: string;
  /** Focus a live agent pane, or reopen its persisted session. */
  focusOrOpen(row: TreeRow): Promise<void>;
  /** Start a new agent using the selected ledger context. */
  startNewAgent?(row: TreeRow): Promise<void>;
  /** Select mode chooses one context; its parent chain is included by the caller. */
  mode?: "navigate" | "select";
  initialSelectedId?: string;
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
    if (!raw) { out.push(""); continue; }
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
  let viewIndex = Math.max(0, ancestorFiles.length - 1);
  let state: UiState = { kind: "browse" };
  let cursor = 0;
  let scroll = 0;
  const isSelect = input.mode === "select";

  const viewRootFile = () => ancestorFiles[viewIndex] ?? currentFile;
  const hasParent = () => viewIndex > 0;
  const rows = () => computeTreeRows(graph, viewRootFile(), currentFile, currentLedgerId);

  if (input.initialSelectedId) {
    const initial = rows().findIndex((row) => row.node?.id === input.initialSelectedId);
    if (initial >= 0) cursor = initial;
  }

  const actionsFor = (row: TreeRow): string[] => [
    ...(row.node ? ["View context"] : []),
    "Open agent session",
    ...(row.node && input.startNewAgent ? ["Start new agent"] : []),
    CANCEL,
  ];

  const contextLines = (row: TreeRow): { title: string; lines: string[] } => {
    const node = row.node;
    if (!node) return { title: row.label, lines: ["(no context was passed to this agent)"] };
    const chain: ContextLedgerNode[] = [];
    const seen = new Set<string>();
    let current: ContextLedgerNode | undefined = node;
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      chain.unshift(current);
      current = current.parentId ? graph.nodes.get(current.parentId) : undefined;
    }
    const lines = [
      `Created: ${node.createdAt}`,
      "",
      "Context path:",
      ...chain.map((item) => `  ${item.sourceSessionName}`),
      "",
      ...chain.flatMap((item) => {
        const markdown = nodeToMarkdown(item);
        return markdown ? ["", `Context from ${item.sourceSessionName}:`, ...markdown.split("\n")] : [];
      }),
    ];
    return { title: row.label, lines };
  };

  return ctx.ui.custom<string | undefined>((tui, theme, _kb, done) => {
    const render = (width: number): string[] => {
      const termHeight = process.stdout.rows ?? 24;
      const totalHeight = Math.min(Math.max(10, termHeight - 2), 34);
      const innerWidth = width - 2;
      const bodyHeight = totalHeight - 4;
      const bdr = (s: string) => theme.fg("border", s);
      const acc = (s: string) => theme.fg("accent", s);
      const dim = (s: string) => theme.fg("dim", s);

      if (state.kind === "context") {
        const body = wrapText(state.lines.join("\n"), innerWidth - 4);
        const lines = [bdr(`╭${hLine("─", innerWidth)}╮`)];
        lines.push(bdr("│") + " " + padRight(truncateToWidth(acc(theme.bold(state.title)), innerWidth - 2), innerWidth - 2) + " " + bdr("│"));
        lines.push(bdr(`├${hLine("─", innerWidth)}┤`));
        for (let i = 0; i < bodyHeight; i++) {
          const text = body[state.scroll + i] ?? "";
          lines.push(bdr("│") + "  " + padRight(truncateToWidth(text, innerWidth - 4, "…"), innerWidth - 4) + "  " + bdr("│"));
        }
        lines.push(bdr(`├${hLine("─", innerWidth)}┤`));
        lines.push(bdr("│") + " " + padRight(dim("alt-p/n scroll · esc back"), innerWidth - 2) + " " + bdr("│"));
        lines.push(bdr(`╰${hLine("─", innerWidth)}╯`));
        return lines;
      }

      const list = rows();
      const menuRows = state.kind === "menu" ? state.actions : undefined;
      const selectedIndex = state.kind === "menu" ? state.cursor : cursor;
      const listLength = menuRows?.length ?? list.length;
      if (selectedIndex < scroll) scroll = selectedIndex;
      if (selectedIndex >= scroll + bodyHeight) scroll = selectedIndex - bodyHeight + 1;
      scroll = Math.max(0, Math.min(scroll, Math.max(0, listLength - bodyHeight)));

      const title = isSelect ? "Choose context" : "Agent context tree";
      const lines = [bdr(`╭${hLine("─", innerWidth)}╮`)];
      lines.push(bdr("│") + " " + padRight(acc(theme.bold(title)), innerWidth - 2) + " " + bdr("│"));
      lines.push(bdr(`├${hLine("─", innerWidth)}┤`));

      for (let i = 0; i < bodyHeight; i++) {
        const index = scroll + i;
        let text = "";
        if (menuRows) {
          const action = menuRows[index];
          if (action) text = `${index === selectedIndex ? acc("›") : " "} ${index === selectedIndex ? theme.bold(action) : action}`;
        } else {
          const row = list[index];
          if (row) {
            const active = index === cursor;
            const marker = active ? acc("›") : " ";
            const label = isSelect && !row.node ? `${row.label} — no context` : row.label;
            const name = row.isCurrent ? acc(label) : label;
            text = `${marker} ${row.prefix}${dim(row.number)} ${active ? theme.bold(name) : name}`;
            if (isSelect && !row.node) text = dim(text);
          }
        }
        lines.push(bdr("│") + " " + padRight(truncateToWidth(text, innerWidth - 2, "…"), innerWidth - 2) + " " + bdr("│"));
      }

      lines.push(bdr(`├${hLine("─", innerWidth)}┤`));
      const hints = state.kind === "menu"
        ? "j/k move · enter choose · esc back"
        : isSelect
          ? `j/k move${hasParent() ? " · h parent" : ""} · enter include context · esc cancel`
          : `j/k move${hasParent() ? " · h parent" : ""} · enter actions · esc close`;
      lines.push(bdr("│") + " " + padRight(dim(hints), innerWidth - 2) + " " + bdr("│"));
      lines.push(bdr(`╰${hLine("─", innerWidth)}╯`));
      return lines;
    };

    const rerender = () => tui.requestRender();
    const handleInput = (data: string) => {
      if (state.kind === "context") {
        if (matchesKey(data, Key.alt("p"))) state.scroll = Math.max(0, state.scroll - 10);
        else if (matchesKey(data, Key.alt("n"))) state.scroll += 10;
        else if (matchesKey(data, Key.escape) || data === "q") state = { kind: "browse" };
        rerender();
        return;
      }

      if (state.kind === "menu") {
        if (matchesKey(data, Key.up) || data === "k") state.cursor = Math.max(0, state.cursor - 1);
        else if (matchesKey(data, Key.down) || data === "j") state.cursor = Math.min(state.actions.length - 1, state.cursor + 1);
        else if (matchesKey(data, Key.escape) || data === "q" || data === "h") state = { kind: "browse" };
        else if (matchesKey(data, Key.enter)) {
          const action = state.actions[state.cursor];
          const row = rows()[cursor];
          if (!row) return;
          if (action === CANCEL) state = { kind: "browse" };
          else if (action === "View context") {
            const detail = contextLines(row);
            state = { kind: "context", ...detail, scroll: 0 };
          } else if (action === "Start new agent" && input.startNewAgent) {
            void input.startNewAgent(row).finally(() => { state = { kind: "browse" }; rerender(); });
          } else if (action === "Open agent session") {
            void focusOrOpen(row).finally(() => { state = { kind: "browse" }; rerender(); });
          }
        }
        rerender();
        return;
      }

      const list = rows();
      if (matchesKey(data, Key.up) || data === "k") cursor = Math.max(0, cursor - 1);
      else if (matchesKey(data, Key.down) || data === "j") cursor = Math.min(Math.max(0, list.length - 1), cursor + 1);
      else if ((data === "h" || data === "H") && hasParent()) {
        viewIndex--;
        cursor = 0;
        scroll = 0;
      } else if (matchesKey(data, Key.enter)) {
        const row = list[cursor];
        if (!row) return;
        if (isSelect) {
          if (row.node) {
            done(`inherit:${row.node.id}`);
            return;
          }
        } else state = { kind: "menu", cursor: 0, actions: actionsFor(row) };
      } else if (matchesKey(data, Key.escape) || data === "q" || matchesKey(data, Key.ctrl("c"))) {
        done();
        return;
      }
      rerender();
    };

    return { render, invalidate: () => {}, handleInput };
  }, {
    overlay: true,
    overlayOptions: {
      anchor: "top-center" as const,
      offsetY: 1,
      width: "75%",
      minWidth: 60,
      maxHeight: "85%",
    },
  });
}
