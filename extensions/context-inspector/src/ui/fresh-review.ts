import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { BorderedLoader } from "@earendil-works/pi-coding-agent";
import { Editor, Key, matchesKey, truncateToWidth, wrapTextWithAnsi, type EditorTheme, type Focusable } from "@earendil-works/pi-tui";
import type { FreshReviewResult, PreparedContext } from "../fresh/types.js";

export async function runSelectionLoader(
  ctx: ExtensionCommandContext,
  operation: (signal: AbortSignal) => Promise<string[]>,
): Promise<string[] | undefined> {
  const result = await ctx.ui.custom<{ value?: string[]; error?: unknown; cancelled?: boolean }>((tui, theme, _kb, done) => {
    const loader = new BorderedLoader(tui, theme, "Selecting fresh-session files...");
    let settled = false;
    const finish = (value: { value?: string[]; error?: unknown; cancelled?: boolean }) => {
      if (settled) return;
      settled = true;
      done(value);
    };
    loader.onAbort = () => finish({ cancelled: true });
    operation(loader.signal).then((value) => finish({ value })).catch((error) => finish({ error }));
    return loader;
  });

  if (!result || result.cancelled) return undefined;
  if (result.error) throw result.error;
  return result.value;
}

export async function reviewFreshTransition(
  ctx: ExtensionCommandContext,
  prepared: PreparedContext,
  initialObjective = "",
): Promise<FreshReviewResult> {
  return ctx.ui.custom<FreshReviewResult>((tui, theme, _keybindings, done) => {
    const editorTheme: EditorTheme = {
      borderColor: (s) => theme.fg("accent", s),
      selectList: {
        selectedPrefix: (s) => theme.fg("accent", s),
        selectedText: (s) => theme.fg("accent", s),
        description: (s) => theme.fg("muted", s),
        scrollInfo: (s) => theme.fg("dim", s),
        noMatch: (s) => theme.fg("warning", s),
      },
    };
    const editor = new Editor(tui, editorTheme);
    editor.setText(initialObjective);
    let objective = initialObjective;
    let editing = true;
    let validationMessage = "";
    editor.onChange = (text) => { objective = text; };
    editor.onSubmit = (text) => {
      objective = text;
      if (!objective.trim()) {
        validationMessage = "A non-empty kickoff objective is required.";
      } else {
        validationMessage = "";
        editing = false;
      }
      tui.requestRender();
    };

    const component: Focusable & {
      render(width: number): string[];
      handleInput(data: string): void;
      invalidate(): void;
    } = {
      focused: true,
      render(width: number) {
        const inner = Math.max(10, width - 2);
        const lines: string[] = [theme.fg("accent", theme.bold("Fresh Context Session")), ""];
        lines.push(theme.fg("success", `Included (${prepared.included.length})`));
        for (const file of prepared.included) lines.push(`  ✓ ${file.path}  ${formatBytes(file.bytes)} · est. ${formatTokens(file.estimatedTokens)} tokens`);
        if (prepared.excluded.length) {
          lines.push("", theme.fg("warning", `Excluded (${prepared.excluded.length})`));
          for (const file of prepared.excluded) lines.push(`  ! ${file.path} — ${file.detail}`);
        }
        lines.push("", theme.fg("accent", `File context: est. ${formatTokens(prepared.estimatedTokens)} tokens (${formatBytes(prepared.totalBytes)})`), "");
        lines.push(theme.fg("accent", theme.bold("Kickoff objective")));
        if (editing) {
          lines.push(...editor.render(inner));
          if (validationMessage) lines.push(theme.fg("error", validationMessage));
          lines.push(theme.fg("dim", "Enter review • Esc cancel and keep draft"));
        } else {
          for (const line of wrapTextWithAnsi(objective, Math.max(1, inner - 2))) lines.push(`  ${line}`);
          lines.push("", theme.fg("dim", "Enter confirm and start • e edit objective • Esc cancel and keep draft"));
        }

        const top = theme.fg("borderAccent", `┌${"─".repeat(inner)}┐`);
        const bottom = theme.fg("borderAccent", `└${"─".repeat(inner)}┘`);
        return [top, ...lines.map((line) => theme.fg("borderAccent", "│") + truncateToWidth(line, inner, "…", true) + theme.fg("borderAccent", "│")), bottom];
      },
      handleInput(data: string) {
        if (editing) {
          if (matchesKey(data, Key.escape)) {
            objective = editor.getExpandedText();
            done({ action: "cancel", objective });
            return;
          }
          editor.handleInput(data);
          if (editing) objective = editor.getExpandedText();
          tui.requestRender();
          return;
        }
        if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) done({ action: "cancel", objective });
        else if (matchesKey(data, Key.enter)) done({ action: "confirm", objective });
        else if (data === "e" || data === "E") {
          editing = true;
          editor.setText(objective);
          tui.requestRender();
        }
      },
      invalidate() { editor.invalidate(); },
    };
    Object.defineProperty(component, "focused", {
      get: () => editor.focused,
      set: (value: boolean) => { editor.focused = value; },
    });
    return component;
  }, {
    overlay: true,
    overlayOptions: { width: "82%", minWidth: 64, maxHeight: "90%", margin: 1 },
  });
}

function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
}

function formatBytes(count: number): string {
  if (count < 1000) return `${count} B`;
  return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)} KB`;
}

