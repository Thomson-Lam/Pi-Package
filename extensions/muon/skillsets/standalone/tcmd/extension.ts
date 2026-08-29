import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  DynamicBorder,
  getSelectListTheme,
  getSettingsListTheme,
  truncateTail,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { relativeDelta } from "./relative-diff.js";

const STATE_ENTRY = "tcmd-state";
const LEGACY_STATE_ENTRY = "tmux-human-command-state";
const STATUS_ID = "tcmd";
const SCRIPT = fileURLToPath(new URL("./scripts/tmux-human-command", import.meta.url));
const OBSERVER_INTERVAL_SECONDS = "1";
const OBSERVER_LINES = "600";
const CAPTURE_MAX_BYTES = 128 * 1024;
const OBSERVER_MAX_SECONDS = "30";
const RECORD_INTERVAL_MS = 2000;
const RECORD_MAX_SECONDS = 600;
const RECORD_OUTPUT_LINES = 600;
const RECORD_OUTPUT_BYTES = 24 * 1024;
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

type Workflow = "None" | "Staging" | "Full-staging";
type Observation = "observe" | "record";
type Delivery = "Auto-send to agent" | "Manual: attach to my next prompt";
type CommandReview =
  | { kind: "approve" }
  | { kind: "feedback"; feedback: string }
  | { kind: "cancel" };

type ActiveRun = {
  pane: Pane;
  command: string;
  plan: string;
  baseline: string;
  startedAt: number;
  observation: Observation;
  lastSnapshot: string;
  lastCommandSnapshot: string;
  commandSeen: boolean;
  recordedOutput: string;
  recordedOutputTruncated: boolean;
  recordPoll?: Promise<void>;
  finalizing?: boolean;
  controller: AbortController;
};

const WORKFLOWS: Workflow[] = ["None", "Staging", "Full-staging"];
const OBSERVATIONS: Observation[] = ["observe", "record"];
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

async function reviewCommand(
  ctx: ExtensionContext,
  details: string,
): Promise<CommandReview> {
  const action = await ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
    const items: SelectItem[] = [
      { value: "approve", label: "Approve" },
      { value: "feedback", label: "Give feedback", description: "Return feedback to the agent without running the command" },
      { value: "cancel", label: "Cancel" },
    ];
    const list = new SelectList(items, items.length, getSelectListTheme());
    list.onSelect = (item) => done(item.value);
    list.onCancel = () => done(undefined);

    const container = new Container();
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    container.addChild(new Text(details, 1, 0));
    container.addChild(list);
    container.addChild(new Text(theme.fg("dim", "↑↓/j/k navigate • enter select • esc cancel"), 1, 0));
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        if (data === "j" || data === "J") list.handleInput("\x1b[B");
        else if (data === "k" || data === "K") list.handleInput("\x1b[A");
        else list.handleInput(data);
        tui.requestRender();
      },
    };
  });
  if (!action || action === "cancel") return { kind: "cancel" };
  if (action === "approve") return { kind: "approve" };

  const feedback = await ctx.ui.editor("Feedback for agent", "");
  if (feedback === undefined) return { kind: "cancel" };
  if (!feedback.trim()) {
    ctx.ui.notify("Feedback was empty; command was not staged.", "warning");
    return { kind: "cancel" };
  }
  return { kind: "feedback", feedback: feedback.trim() };
}

function paneLabel(pane: Pane): string {
  return `${pane.id} ${pane.session}:${pane.window}.${pane.index}`;
}

function commandScopedSnapshot(snapshot: string, command: string): string | undefined {
  const commandIndex = snapshot.lastIndexOf(command);
  if (commandIndex < 0) return undefined;
  const lineStart = snapshot.lastIndexOf("\n", commandIndex) + 1;
  return snapshot.slice(lineStart).trim();
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
    const result = await pi.exec("env", [SCRIPT, "capture-pane", pane.id, OBSERVER_LINES], { signal, timeout: 5000 });
    if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `Unable to capture ${pane.id}`);
    return truncateTail(result.stdout, {
      maxLines: Number(OBSERVER_LINES),
      maxBytes: CAPTURE_MAX_BYTES,
    }).content;
  };

  const appendRecordOutput = (run: ActiveRun, text: string): void => {
    if (!text) return;
    const combined = run.recordedOutput ? `${run.recordedOutput}\n${text}` : text;
    const bounded = truncateTail(combined, {
      maxLines: RECORD_OUTPUT_LINES,
      maxBytes: RECORD_OUTPUT_BYTES,
    });
    run.recordedOutput = bounded.content;
    run.recordedOutputTruncated ||= bounded.truncated;
  };

  const resultContent = (run: ActiveRun, output: string, confidence: string, truncated: boolean): string => [
    `${paneLabel(run.pane)} command result`,
    `Elapsed: ${Date.now() - run.startedAt}ms`,
    `Observation: ${run.observation}`,
    `Confidence: ${confidence}`,
    `Truncated: ${truncated ? "yes" : "no"}`,
    "",
    output || "[No pane output captured.]",
  ].join("\n");

  const deliver = (run: ActiveRun, output: string, confidence: string, truncated: boolean) => {
    const content = resultContent(run, output, confidence, truncated);
    const automatic = delivery.startsWith("Auto");
    pi.sendMessage(
      {
        customType: "tmux-human-command-output",
        display: automatic,
        content,
        details: { pane: run.pane, command: run.command, confidence, truncated, observation: run.observation },
      },
      { deliverAs: "followUp", triggerTurn: automatic },
    );
  };

  const collectRecordSnapshot = async (run: ActiveRun, final = false): Promise<string> => {
    const current = await capture(run.pane, final ? undefined : run.controller.signal);
    if (!final && (active !== run || run.finalizing || run.controller.signal.aborted)) return current;

    const scoped = commandScopedSnapshot(current, run.command);
    if (scoped !== undefined) {
      const delta = run.commandSeen
        ? relativeDelta(run.lastCommandSnapshot, scoped)
        : { text: scoped, aligned: true };
      appendRecordOutput(run, delta.text);
      run.lastCommandSnapshot = scoped;
      run.commandSeen = true;
    } else if (run.commandSeen) {
      appendRecordOutput(run, relativeDelta(run.lastSnapshot, current).text);
    }
    run.lastSnapshot = current;
    return current;
  };

  const record = async (run: ActiveRun): Promise<void> => {
    const deadline = run.startedAt + RECORD_MAX_SECONDS * 1000;
    try {
      await collectRecordSnapshot(run);
      while (active === run && !run.finalizing && Date.now() < deadline) {
        await sleep(RECORD_INTERVAL_MS);
        if (active !== run || run.finalizing || run.controller.signal.aborted) return;
        await collectRecordSnapshot(run);
      }
    } catch {
      // Preserve collected output and let record-stop perform the final capture.
    }
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
    const scoped = commandScopedSnapshot(current, run.command);
    const bounded = truncateTail(scoped ?? relativeDelta(run.baseline, current).text, { maxLines: 600, maxBytes: 24 * 1024 });
    const output = confidence === "observation-timeout" && !bounded.content.trim()
      ? "Command took longer than observer limit to run."
      : bounded.content;
    deliver(run, output, confidence, bounded.truncated);
    if (sessionContext) updateStatus(sessionContext, selectedPane, delivery);
  };

  const finishRecord = async (run: ActiveRun): Promise<{ content: string; truncated: boolean }> => {
    if (run.finalizing) return { content: run.recordedOutput, truncated: run.recordedOutputTruncated };
    run.finalizing = true;
    run.controller.abort();
    await run.recordPoll;
    let finalSnapshot = "";
    try {
      finalSnapshot = await collectRecordSnapshot(run, true);
    } catch {
      // Preserve the output collected before the final capture.
    }
    if (!run.recordedOutput && finalSnapshot) appendRecordOutput(run, commandScopedSnapshot(finalSnapshot, run.command) ?? finalSnapshot);
    active = undefined;
    if (sessionContext) updateStatus(sessionContext, selectedPane, delivery);
    return { content: run.recordedOutput, truncated: run.recordedOutputTruncated };
  };

  const reportFinishError = (run: ActiveRun, error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[tcmd] finalization failed for ${run.command}: ${message}`);
    try {
      sessionContext?.ui.notify(`tcmd finalization failed: ${message}`, "error");
    } catch {
      // Preserve the original finalization error when the UI is unavailable.
    }
  };

  const finishSafely = async (run: ActiveRun, confidence: string): Promise<void> => {
    try {
      await finish(run, confidence);
    } catch (error) {
      reportFinishError(run, error);
    }
  };

  const observe = async (run: ActiveRun): Promise<void> => {
    let previous = run.baseline;
    let changed = false;
    let stable = 0;
    const deadline = Date.now() + Number(OBSERVER_MAX_SECONDS) * 1000;
    while (active === run && Date.now() < deadline) {
      await sleep(Number(OBSERVER_INTERVAL_SECONDS) * 1000);
      if (run.controller.signal.aborted) return;

      let current: string;
      try {
        current = await capture(run.pane, run.controller.signal);
      } catch {
        await finishSafely(run, "target-disappeared");
        return;
      }
      if (current !== previous) {
        previous = current;
        changed = true;
        stable = 0;
      } else if (changed) {
        stable++;
        if (stable >= 2) {
          await finishSafely(run, "settled");
          return;
        }
      }
    }
    if (active === run) await finishSafely(run, "observation-timeout");
  };

  const stage = async (command: string, plan: string, observation: Observation = "observe"): Promise<string> => {
    if (!sessionContext) throw new Error("No active Pi session");
    if (!selectedPane) throw new Error("No tmux pane selected. Ask the user to run /cmd first.");
    if (workflow === "None") throw new Error("Command assistance is disabled. Choose it in /cmd first.");
    if (!OBSERVATIONS.includes(observation)) throw new Error("Choose either observe or record for command observation.");
    if (active) throw new Error("A staged command is already awaiting completion.");
    if (!command.trim() || /[\r\n]/.test(command)) throw new Error("Stage exactly one non-empty command without newline characters.");
    if (!plan.trim()) throw new Error("Provide the approved action plan before staging a command.");

    const panes = await discoverPanes(pi);
    const current = panes.find((pane) => pane.id === selectedPane!.id);
    if (!current) throw new Error(`Selected tmux pane no longer exists: ${selectedPane.id}`);
    const excludedIds = await protectedPaneIds(pi, panes);
    if (excludedIds.has(current.id)) throw new Error(`Refusing protected tmux pane: ${current.id}`);

    const fullStaging = workflow === "Full-staging";
    const review = await reviewCommand(
      sessionContext,
      [
        `Plan: ${plan}`,
        `Command: ${command}`,
        fullStaging
          ? "This will type the command and press Enter automatically."
          : "This stages text only; it will not press Enter.",
      ].join("\n\n"),
    );
    if (review.kind === "cancel") throw new Error("Command review was cancelled.");
    if (review.kind === "feedback") {
      return [
        "Command was not staged.",
        "feedback:",
        review.feedback,
      ].join("\n\n");
    }

    const baseline = await capture(current);
    const action = fullStaging ? "run" : "stage";
    const staged = await pi.exec("env", [SCRIPT, action, current.id, command], { timeout: 5000 });
    if (staged.code !== 0) throw new Error(staged.stderr.trim() || staged.stdout.trim() || "Unable to stage command");
    const run: ActiveRun = {
      pane: current,
      command,
      plan,
      baseline,
      startedAt: Date.now(),
      observation,
      lastSnapshot: baseline,
      lastCommandSnapshot: "",
      commandSeen: false,
      recordedOutput: "",
      recordedOutputTruncated: false,
      controller: new AbortController(),
    };
    active = run;
    pi.sendMessage(
      {
        customType: "tmux-human-command-staged",
        display: true,
        content: fullStaging
          ? observation === "record"
            ? `Submitted command in ${paneLabel(current)}. It was executed automatically. Recording is active; say done when it finishes.`
            : `Submitted command in ${paneLabel(current)}. It was executed automatically.`
          : observation === "record"
            ? `Staged command in ${paneLabel(current)}. It was not executed. Review it and press Enter in the target pane. Recording is active; say done when it finishes.`
            : `Staged command in ${paneLabel(current)}. It was not executed. Review it and press Enter in the target pane.`,
        details: { pane: current, command, plan, workflow, observation },
      },
      { triggerTurn: false },
    );
    if (observation === "record") {
      run.recordPoll = record(run);
    } else {
      void observe(run);
    }
    return fullStaging
      ? observation === "record"
        ? `Command submitted in ${paneLabel(current)} and executed automatically. Recording is active; ask the user to say done when it finishes.`
        : `Command submitted in ${paneLabel(current)} and executed automatically using observe observation.`
      : observation === "record"
        ? `Command staged in ${paneLabel(current)}. It was not executed; ask the user to press Enter after review, then say done when it finishes.`
        : `Command staged in ${paneLabel(current)}. It was not executed; press Enter in the target pane after review using observe observation.`;
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

  pi.on("session_shutdown", async () => {
    const run = active;
    active = undefined;
    if (run) {
      run.finalizing = true;
      run.controller.abort();
      await run.recordPoll;
    }
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

  pi.registerTool({
    name: "tmux_human_command",
    label: "Tmux human command",
    description: "Stage or execute a command in a tmux pane for the tcmd skill",
    parameters: Type.Object({
      action: StringEnum(["stage", "status", "cancel", "record-stop"] as const),
      command: Type.Optional(Type.String()),
      plan: Type.Optional(Type.String()),
      observation: Type.Optional(StringEnum(["observe", "record"] as const)),
    }),
    async execute(_toolCallId, params) {
      if (!isEnabled()) throw new Error("tcmd is disabled under /muon skills.");
      if (params.action === "stage") {
        const observation = String(params.observation ?? "observe") as Observation;
        return { content: [{ type: "text", text: await stage(String(params.command ?? ""), String(params.plan ?? ""), observation) }] };
      }
      if (params.action === "status") {
        return {
          content: [{
            type: "text",
            text: active
              ? `${active.observation === "record" ? "Recording" : "Observing"} ${active.pane.id}; ${active.observation === "record" ? "call record-stop when the command is done" : "awaiting command result"}.`
              : "No active tmux command observation.",
          }],
        };
      }
      if (params.action === "cancel") {
        const run = active;
        active = undefined;
        if (run) {
          run.finalizing = true;
          run.controller.abort();
          await run.recordPoll;
        }
        return { content: [{ type: "text", text: "Active tmux command observation cancelled." }] };
      }
      if (!active || active.observation !== "record") throw new Error("No active record observation.");
      const run = active;
      const recorded = await finishRecord(run);
      return {
        content: [{ type: "text", text: resultContent(run, recorded.content, "recorded", recorded.truncated) }],
        details: { pane: run.pane, command: run.command, confidence: "recorded", truncated: recorded.truncated },
      };
    },
  });
}
