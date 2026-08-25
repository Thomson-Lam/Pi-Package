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

const STATE_ENTRY = "tcmd-state";
const LEGACY_STATE_ENTRY = "tmux-human-command-state";
const STATUS_ID = "tcmd";
const SCRIPT = fileURLToPath(new URL("./scripts/tmux-human-command", import.meta.url));
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

type Workflow = "None" | "Staging";
type Delivery = "Auto-send to agent" | "Manual: attach to my next prompt";

type ActiveRun = {
  pane: Pane;
  command: string;
  plan: string;
  baseline: string;
  startedAt: number;
  controller: AbortController;
};

const WORKFLOWS: Workflow[] = ["None", "Staging"];
const WORKFLOW_ALIASES: Record<string, Workflow> = {
  "Human-approved command assistance": "Staging",
};
const DELIVERIES: Delivery[] = ["Auto-send to agent", "Manual: attach to my next prompt"];

function isPane(value: unknown): value is Pane {
  if (!value || typeof value !== "object") return false;
  const pane = value as Record<string, unknown>;
  return ["id", "session", "window", "index", "command", "path", "title"].every(
    (key) => typeof pane[key] === "string",
  ) && /^%\d+$/.test(pane.id as string);
}

function restoreState(ctx: ExtensionContext): { pane?: Pane; workflow: Workflow; delivery: Delivery } {
  let restored: { pane?: Pane; workflow?: unknown; delivery?: unknown } = {};
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "custom" || (entry.customType !== STATE_ENTRY && entry.customType !== LEGACY_STATE_ENTRY)) continue;
    const data = entry.data as typeof restored | undefined;
    if (data && typeof data === "object") restored = data;
  }
  const storedWorkflow = typeof restored.workflow === "string" ? restored.workflow : "";
  return {
    pane: isPane(restored.pane) ? restored.pane : undefined,
    workflow: WORKFLOWS.includes(storedWorkflow as Workflow)
      ? storedWorkflow as Workflow
      : WORKFLOW_ALIASES[storedWorkflow] ?? "None",
    delivery: DELIVERIES.includes(restored.delivery as Delivery) ? restored.delivery as Delivery : "Manual: attach to my next prompt",
  };
}

function updateStatus(ctx: ExtensionContext, pane: Pane | undefined, delivery: Delivery): void {
  ctx.ui.setStatus(
    STATUS_ID,
    pane
      ? ctx.ui.theme.fg("accent", `cmd: ${pane.id} · ${delivery.startsWith("Auto") ? "auto" : "manual"}`)
      : undefined,
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

async function protectedPaneIds(pi: ExtensionAPI, panes: Pane[]): Promise<Set<string>> {
  const protectedIds = new Set<string>();
  if (process.env.TMUX_PANE) protectedIds.add(process.env.TMUX_PANE);

  await Promise.all(panes.map(async (pane) => {
    const result = await pi.exec("tmux", [
      "display-message", "-p", "-t", pane.id, "#{pane_id}\t#{@blink_role}\t#{@pi_extension_role}",
    ], { timeout: 2000 });
    const [, blinkRole = "", extensionRole = ""] = result.stdout.trim().split("\t");
    if (blinkRole || extensionRole) protectedIds.add(pane.id);
  }));
  return protectedIds;
}

async function selectPane(
  ctx: ExtensionCommandContext,
  panes: Pane[],
  current: Pane | undefined,
  excludedIds: ReadonlySet<string>,
): Promise<Pane[] | undefined> {
  const availablePanes = panes.filter((pane) => !excludedIds.has(pane.id));
  const available = new Map(availablePanes.map((pane) => [pane.id, pane]));
  const selected = current && available.has(current.id) ? current.id : undefined;

  return ctx.ui.custom<Pane[] | undefined>((tui, theme, _keybindings, done) => {
    const staged = new Set(selected ? [selected] : []);
    const items: SettingItem[] = availablePanes.map((pane) => ({
      id: pane.id,
      label: `${pane.session}:${pane.window}.${pane.index} ${pane.id} ${pane.command}`,
      description: pane.title ? `${pane.title} · ${pane.path}` : pane.path,
      currentValue: staged.has(pane.id) ? "selected" : "ignored",
      values: ["selected", "ignored"],
    }));

    const container = new Container();
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    container.addChild(new Text(theme.fg("accent", theme.bold("Tmux command pane")), 1, 0));
    const list = new SettingsList(
      items,
      Math.min(items.length + 2, 15),
      getSettingsListTheme(),
      (id, value) => {
        if (value === "selected") {
          staged.clear();
          staged.add(id);
        } else {
          staged.delete(id);
        }
      },
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

function paneLabel(pane: Pane): string {
  return `${pane.id} ${pane.session}:${pane.window}.${pane.index}`;
}

function deltaFromBaseline(baseline: string, current: string): string {
  const before = baseline.split("\n");
  const after = current.split("\n");
  let common = 0;
  while (common < before.length && common < after.length && before[common] === after[common]) common++;
  return after.slice(common).join("\n").trim() || current.trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default function registerTmuxHumanCommand(pi: ExtensionAPI, isEnabled: () => boolean): void {
  let selectedPane: Pane | undefined;
  let workflow: Workflow = "None";
  let delivery: Delivery = "Manual: attach to my next prompt";
  let active: ActiveRun | undefined;
  let sessionContext: ExtensionContext | undefined;

  const persist = () => {
    pi.appendEntry(STATE_ENTRY, { pane: selectedPane, workflow, delivery, updatedAt: Date.now() });
  };

  const capture = async (pane: Pane, signal?: AbortSignal): Promise<string> => {
    const result = await pi.exec("env", [SCRIPT, "capture-pane", pane.id, "200"], { signal, timeout: 5000 });
    if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `Unable to capture ${pane.id}`);
    const output = truncateTail(result.stdout, { maxLines: 600, maxBytes: 24 * 1024 });
    return output.truncated
      ? `${output.content}\n\n[Output truncated: showing ${output.outputLines}/${output.totalLines} lines and ${formatSize(output.outputBytes)}/${formatSize(output.totalBytes)}.]`
      : output.content;
  };

  const deliver = (run: ActiveRun, output: string, confidence: string, truncated: boolean) => {
    const content = [
      `${paneLabel(run.pane)} command result`,
      `Elapsed: ${Date.now() - run.startedAt}ms`,
      `Truncated: ${truncated ? "yes" : "no"}`,
      "",
      output || "[No pane output captured.]",
    ].join("\n");
    pi.sendMessage(
      {
        customType: "tmux-human-command-output",
        display: delivery.startsWith("Auto"),
        content,
        details: { pane: run.pane, command: run.command, confidence, truncated },
      },
      { deliverAs: "followUp", triggerTurn: delivery.startsWith("Auto") },
    );
  };

  const finish = async (run: ActiveRun, confidence: string): Promise<void> => {
    if (active !== run) return;
    active = undefined;
    run.controller.abort();
    let current = "";
    try {
      current = await capture(run.pane);
    } catch (error) {
      current = `Unable to capture final pane output: ${error instanceof Error ? error.message : String(error)}`;
    }
    const bounded = truncateTail(deltaFromBaseline(run.baseline, current), { maxLines: 600, maxBytes: 24 * 1024 });
    deliver(run, bounded.content, confidence, bounded.truncated);
    if (sessionContext) updateStatus(sessionContext, selectedPane, delivery);
  };

  const observe = async (run: ActiveRun): Promise<void> => {
    let previous = run.baseline;
    let changed = false;
    let stable = 0;
    const deadline = Date.now() + 30_000;
    while (active === run && Date.now() < deadline) {
      await sleep(1000);
      if (run.controller.signal.aborted) return;
      try {
        const current = await capture(run.pane, run.controller.signal);
        if (current !== previous) {
          previous = current;
          changed = true;
          stable = 0;
        } else if (changed) {
          stable++;
          if (stable >= 2) {
            await finish(run, "settled");
            return;
          }
        }
      } catch {
        await finish(run, "target-disappeared");
        return;
      }
    }
    if (active === run) await finish(run, "observation-timeout");
  };

  const stage = async (command: string, plan: string): Promise<string> => {
    if (!sessionContext) throw new Error("No active Pi session");
    if (!selectedPane) throw new Error("No tmux pane selected. Ask the user to run /cmd first.");
    if (workflow === "None") throw new Error("Command assistance is disabled. Choose it in /cmd first.");
    if (active) throw new Error("A staged command is already awaiting completion.");
    if (!command.trim() || /[\r\n]/.test(command)) throw new Error("Stage exactly one non-empty command without newline characters.");
    if (!plan.trim()) throw new Error("Provide the approved action plan before staging a command.");

    const panes = await discoverPanes(pi);
    const current = panes.find((pane) => pane.id === selectedPane!.id);
    if (!current) throw new Error(`Selected tmux pane no longer exists: ${selectedPane.id}`);
    const excludedIds = await protectedPaneIds(pi, panes);
    if (excludedIds.has(current.id)) throw new Error(`Refusing protected tmux pane: ${current.id}`);

    const approved = await sessionContext.ui.confirm(
      "Approve command staging?",
      `Plan: ${plan}\n\nTarget: ${paneLabel(current)}\nCommand: ${command}\n\nThis stages text only; it will not press Enter.`,
    );
    if (!approved) throw new Error("Command staging was not approved.");

    const staged = await pi.exec("env", [SCRIPT, "stage", current.id, command], { timeout: 5000 });
    if (staged.code !== 0) throw new Error(staged.stderr.trim() || staged.stdout.trim() || "Unable to stage command");
    const baseline = await capture(current);
    const run: ActiveRun = {
      pane: current,
      command,
      plan,
      baseline,
      startedAt: Date.now(),
      controller: new AbortController(),
    };
    active = run;
    pi.sendMessage(
      {
        customType: "tmux-human-command-staged",
        display: true,
        content: `Staged command in ${paneLabel(current)}. It was not executed. Review it and press Enter in the target pane.`,
        details: { pane: current, command, plan },
      },
      { triggerTurn: false },
    );
    void observe(run);
    return `Command staged in ${paneLabel(current)}. It was not executed; press Enter in the target pane after review.`;
  };

  pi.on("session_start", (_event, ctx) => {
    sessionContext = ctx;
    const enabled = isEnabled();
    const activeTools = pi.getActiveTools().filter((name) => name !== "tmux_human_command");
    pi.setActiveTools(enabled ? [...activeTools, "tmux_human_command"] : activeTools);
    if (enabled) {
      const restored = restoreState(ctx);
      selectedPane = restored.pane;
      workflow = restored.workflow;
      delivery = restored.delivery;
    } else {
      selectedPane = undefined;
      workflow = "None";
    }
    updateStatus(ctx, selectedPane, delivery);
  });

  pi.on("session_shutdown", () => {
    active?.controller.abort();
    active = undefined;
    sessionContext = undefined;
  });

  pi.registerCommand("cmd", {
    description: "Select a tmux pane for human-approved command assistance",
    handler: async (_args, ctx) => {
      if (!isEnabled()) {
        ctx.ui.notify("Enable tcmd under /muon skills first.", "warning");
        return;
      }
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/cmd requires Pi TUI mode.", "error");
        return;
      }
      try {
        const panes = await discoverPanes(pi);
        const excludedIds = await protectedPaneIds(pi, panes);
        const available = panes.filter((pane) => !excludedIds.has(pane.id));
        if (!available.length) {
          ctx.ui.notify("No safe tmux panes found.", "warning");
          return;
        }
        const selection = await selectPane(ctx, panes, selectedPane, excludedIds);
        if (selection === undefined) return;
        selectedPane = selection[0];
        if (!selectedPane) {
          persist();
          updateStatus(ctx, undefined, delivery);
          ctx.ui.notify("Tmux command target cleared.", "info");
          return;
        }
        workflow = await ctx.ui.select("Command workflow", WORKFLOWS);
        if (!workflow) return;
        delivery = await ctx.ui.select("Output delivery", DELIVERIES);
        if (!delivery) return;
        persist();
        updateStatus(ctx, selectedPane, delivery);
        pi.sendMessage(
          {
            customType: "tmux-human-command-selection",
            display: true,
            content: [
              `Active tmux command target: ${paneLabel(selectedPane)}.`,
              "Use the tcmd skill if you have not yet.",
            ].join("\n"),
            details: { pane: selectedPane, workflow, delivery },
          },
          { triggerTurn: false },
        );
        ctx.ui.notify(`Tmux command target attached: ${selectedPane.id}.`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("cmdone", {
    description: "Complete the active tmux command observation",
    handler: async (_args, ctx) => {
      if (!active) {
        ctx.ui.notify("No active tmux command observation.", "info");
        return;
      }
      await finish(active, "human-completed");
      ctx.ui.notify("Tmux command output delivered.", "info");
    },
  });

  pi.registerTool({
    name: "tmux_human_command",
    label: "Tmux human command",
    description: "Stage a command in a tmux pane for the tlogs skill",
    parameters: Type.Object({
      action: StringEnum(["stage", "status", "cancel", "done"] as const),
      command: Type.Optional(Type.String()),
      plan: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params) {
      if (!isEnabled()) throw new Error("tcmd is disabled under /muon skills.");
      if (params.action === "stage") return { content: [{ type: "text", text: await stage(String(params.command ?? ""), String(params.plan ?? "")) }] };
      if (params.action === "status") {
        return { content: [{ type: "text", text: active ? `Awaiting human execution in ${active.pane.id}.` : "No active staged command." }] };
      }
      if (params.action === "cancel") {
        if (active) {
          active.controller.abort();
          active = undefined;
        }
        return { content: [{ type: "text", text: "Active tmux command observation cancelled." }] };
      }
      if (active) await finish(active, "human-completed");
      return { content: [{ type: "text", text: "Tmux command observation completed." }] };
    },
  });
}
