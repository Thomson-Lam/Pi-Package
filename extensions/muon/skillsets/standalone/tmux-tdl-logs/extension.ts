import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  DynamicBorder,
  formatSize,
  getSettingsListTheme,
  truncateTail,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const STATE_ENTRY = "tmux-tdl-logs-state";
const STATUS_ID = "tmux-tdl-logs";
const SCRIPT = fileURLToPath(new URL("./scripts/tmux-tdl-logs", import.meta.url));
const PANE_FORMAT = [
  "#{pane_id}",
  "#{session_name}",
  "#{window_name}",
  "#{pane_index}",
  "#{pane_current_command}",
  "#{pane_current_path}",
  "#{pane_title}",
].join("\t");

interface Pane {
  id: string;
  session: string;
  window: string;
  index: string;
  command: string;
  path: string;
  title: string;
}

type PromptMode = "None" | "Snapshot" | "Bounded watch" | "Record reproduction";

const PROMPTS: Record<Exclude<PromptMode, "None">, string> = {
  Snapshot: "Capture a current snapshot of the selected pane logs and identify relevant errors or warnings.",
  "Bounded watch": "Watch the selected panes briefly while I run the test, then report relevant new output.",
  "Record reproduction": "Start recording the selected panes, tell me when ready, and wait for me to say done before stopping and searching the logs.",
};

function isPane(value: unknown): value is Pane {
  if (!value || typeof value !== "object") return false;
  const pane = value as Record<string, unknown>;
  return ["id", "session", "window", "index", "command", "path", "title"].every(
    (key) => typeof pane[key] === "string",
  ) && /^%\d+$/.test(pane.id as string);
}

function restoreSelection(ctx: ExtensionContext): Pane[] {
  let panes: Pane[] = [];
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "custom" || entry.customType !== STATE_ENTRY) continue;
    const candidate = (entry.data as { panes?: unknown } | undefined)?.panes;
    if (Array.isArray(candidate) && candidate.every(isPane)) panes = candidate;
  }
  return panes;
}

function updateStatus(ctx: ExtensionContext, panes: Pane[]): void {
  ctx.ui.setStatus(
    STATUS_ID,
    panes.length ? ctx.ui.theme.fg("accent", `logs: ${panes.length} pane${panes.length === 1 ? "" : "s"}`) : undefined,
  );
}

async function discoverPanes(pi: ExtensionAPI): Promise<Pane[]> {
  const result = await pi.exec("tmux", ["list-panes", "-a", "-F", PANE_FORMAT], { timeout: 5000 });
  if (result.code !== 0) throw new Error(result.stderr.trim() || "Unable to list tmux panes");
  return result.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [id = "", session = "", window = "", index = "", command = "", path = "", title = ""] = line.split("\t");
      return { id, session, window, index, command, path, title };
    })
    .filter(isPane);
}

async function selectPanes(ctx: ExtensionCommandContext, panes: Pane[], current: Pane[]): Promise<Pane[] | undefined> {
  const available = new Map(panes.map((pane) => [pane.id, pane]));
  const staged = new Set(current.map((pane) => pane.id).filter((id) => available.has(id)));

  return ctx.ui.custom<Pane[] | undefined>((tui, theme, _keybindings, done) => {
    const items: SettingItem[] = panes.map((pane) => ({
      id: pane.id,
      label: `${pane.session}:${pane.window}.${pane.index} ${pane.id} ${pane.command}`,
      description: pane.title ? `${pane.title} · ${pane.path}` : pane.path,
      currentValue: staged.has(pane.id) ? "selected" : "ignored",
      values: ["selected", "ignored"],
    }));

    const container = new Container();
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    container.addChild(new Text(theme.fg("accent", theme.bold("Tmux log panes")), 1, 0));
    const list = new SettingsList(
      items,
      Math.min(items.length + 2, 15),
      getSettingsListTheme(),
      (id, value) => value === "selected" ? staged.add(id) : staged.delete(id),
      () => done(Array.from(staged).map((id) => available.get(id)!).filter(Boolean)),
      { enableSearch: true },
    );
    container.addChild(list);
    container.addChild(new Text(theme.fg("dim", "↑↓/j/k navigate • enter toggle • esc apply"), 1, 0));
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        if (data === "j" || data === "J") list.handleInput?.("\x1b[B");
        else if (data === "k" || data === "K") list.handleInput?.("\x1b[A");
        else list.handleInput?.(data);
        tui.requestRender();
      },
    };
  });
}

function attachSelection(pi: ExtensionAPI, panes: Pane[]): void {
  const lines = panes.map(
    (pane) => `- ${pane.id} ${pane.session}:${pane.window}.${pane.index} command=${pane.command} path=${pane.path}`,
  );
  pi.sendMessage(
    {
      customType: "tmux-tdl-logs-selection",
      display: true,
      content: [
        "Active tmux log selection (replaces earlier selections):",
        ...lines,
        "Use tmux_tdl_logs only for these panes. Keep captures small. For a reproduction, start recording, wait for the user to say done, then stop before searching or reading it.",
      ].join("\n"),
      details: { panes },
    },
    { triggerTurn: false },
  );
}

function validateBoundedWatch(action: string, args: string[]): void {
  if (action !== "watch-pane" && action !== "watch-servers") return;
  const offset = action === "watch-pane" ? 1 : 0;
  const interval = Number(args[offset] ?? 5);
  const count = Number(args[offset + 1] ?? 3);
  if (!Number.isFinite(interval) || !Number.isInteger(count) || interval <= 0 || count <= 0) {
    throw new Error("Watch interval and count must be positive numbers");
  }
  if (interval * Math.max(0, count - 1) > 30) {
    throw new Error("Bounded watches may wait at most 30 seconds; use record-start for longer observation");
  }
}

export default function registerTmuxTdlLogs(pi: ExtensionAPI, isEnabled: () => boolean): void {
  let selectedPanes: Pane[] = [];

  pi.on("session_start", (_event, ctx) => {
    const enabled = isEnabled();
    const activeTools = pi.getActiveTools().filter((name) => name !== "tmux_tdl_logs");
    pi.setActiveTools(enabled ? [...activeTools, "tmux_tdl_logs"] : activeTools);
    selectedPanes = enabled ? restoreSelection(ctx) : [];
    updateStatus(ctx, selectedPanes);
  });

  pi.registerCommand("tdlogs", {
    description: "Select tmux panes and prepare a focused log workflow",
    handler: async (_args, ctx) => {
      if (!isEnabled()) {
        ctx.ui.notify("Enable tmux-tdl-logs under /muon skills first.", "warning");
        return;
      }
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/tdlogs requires Pi TUI mode.", "error");
        return;
      }
      try {
        const panes = await discoverPanes(pi);
        if (!panes.length) {
          ctx.ui.notify("No tmux panes found.", "warning");
          return;
        }
        const selection = await selectPanes(ctx, panes, selectedPanes);
        if (selection === undefined) return;
        selectedPanes = selection;
        pi.appendEntry(STATE_ENTRY, { panes: selectedPanes, updatedAt: Date.now() });
        updateStatus(ctx, selectedPanes);
        if (!selectedPanes.length) {
          ctx.ui.notify("Tmux log selection cleared.", "info");
          return;
        }

        const mode = await ctx.ui.select("Log workflow", ["None", "Snapshot", "Bounded watch", "Record reproduction"] satisfies PromptMode[]);
        attachSelection(pi, selectedPanes);
        if (mode && mode !== "None") ctx.ui.setEditorText(PROMPTS[mode as Exclude<PromptMode, "None">]);
        ctx.ui.notify(`${selectedPanes.length} tmux pane${selectedPanes.length === 1 ? "" : "s"} attached.`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerTool({
    name: "tmux_tdl_logs",
    label: "Tmux logs",
    description: "Query only the tmux panes selected with /tdlogs. Uses the existing tmux-tdl-logs CLI positional arguments: panes; capture-pane <pane-id> [lines]; capture-servers [lines]; watch-pane <pane-id> [interval] [count] [lines]; watch-servers [interval] [count] [lines]; record-start [name] [interval] [lines] [max-seconds]; record-stop [name]; record-list; record-info/read/page/grep with their normal arguments. Output is limited to 1200 lines or 30KB.",
    promptSnippet: "Query user-selected tmux pane logs",
    promptGuidelines: [
      "Use tmux_tdl_logs only after the user selects panes with /tdlogs; search recordings before reading broad ranges.",
    ],
    parameters: Type.Object({
      action: StringEnum([
        "panes", "capture-pane", "capture-servers", "watch-pane", "watch-servers",
        "record-start", "record-stop", "record-list", "record-info", "record-read", "record-page", "record-grep",
      ] as const),
      args: Type.Optional(Type.Array(Type.String(), { maxItems: 4, description: "Positional arguments after the action" })),
    }),
    async execute(_toolCallId, params, signal) {
      if (!isEnabled()) throw new Error("tmux-tdl-logs is disabled under /muon skills.");
      if (!selectedPanes.length) throw new Error("No tmux panes selected. Ask the user to run /tdlogs first.");
      const args = params.args ?? [];
      validateBoundedWatch(params.action, args);
      const result = await pi.exec(
        "env",
        [`TDL_PANES=${selectedPanes.map((pane) => pane.id).join(",")}`, SCRIPT, params.action, ...args],
        { signal, timeout: 35_000 },
      );
      if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `tmux-tdl-logs exited ${result.code}`);

      const truncation = truncateTail(result.stdout || result.stderr || "OK", { maxLines: 1200, maxBytes: 30 * 1024 });
      let text = truncation.content;
      if (truncation.truncated) {
        text += `\n\n[Output truncated: showing ${truncation.outputLines}/${truncation.totalLines} lines and ${formatSize(truncation.outputBytes)}/${formatSize(truncation.totalBytes)}.]`;
      }
      return {
        content: [{ type: "text", text }],
        details: { action: params.action, args, paneIds: selectedPanes.map((pane) => pane.id), truncation },
      };
    },
  });
}
