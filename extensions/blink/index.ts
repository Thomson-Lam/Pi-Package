import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createEditToolDefinition,
  createWriteToolDefinition,
  withFileMutationQueue,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { BlinkRuntime, type BlinkFeedbackSink } from "./runtime.ts";
import { createBlinkToolDefinitions, type BlinkMode } from "./tools.ts";

const STATUS_KEY = "blink";
const MODE_ENTRY = "blink-mode";
const extensionDir = dirname(fileURLToPath(import.meta.url));
const reviewScript = join(extensionDir, "nvim", "review.lua");

function validMode(value: unknown): value is BlinkMode {
  return value === "off" || value === "slow" || value === "blitz";
}

function restoreMode(ctx: ExtensionContext, fallback: BlinkMode): BlinkMode {
  let mode: BlinkMode = fallback;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== MODE_ENTRY || !entry.data) continue;
    const candidate = (entry.data as { mode?: unknown }).mode;
    if (validMode(candidate)) mode = candidate;
  }
  return mode;
}

async function pickMode(ctx: ExtensionCommandContext, selected: BlinkMode): Promise<BlinkMode | undefined> {
  if (ctx.mode !== "tui") return undefined;
  const items: Array<{ mode: BlinkMode; label: string }> = [
    { mode: "off", label: "Off" },
    { mode: "slow", label: "Slow" },
    { mode: "blitz", label: "Blitz" },
  ];
  return ctx.ui.custom<BlinkMode | undefined>((tui, theme, _keybindings, done) => {
    let index = Math.max(0, items.findIndex((item) => item.mode === selected));
    return {
      render(width: number) {
        const lines = [theme.fg("accent", theme.bold("Blink mode")), "", theme.fg("muted", "j/k:move  l/enter:select  h/esc:cancel"), ""];
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          const active = i === index;
          const selectedMark = item.mode === selected ? " •" : "";
          const text = `${active ? "❯ " : "  "}${item.label}${selectedMark}`;
          lines.push(active ? theme.fg("accent", theme.bold(text)) : text);
        }
        return lines.map((line) => truncateToWidth(line, width));
      },
      invalidate() {},
      handleInput(data: string) {
        if (matchesKey(data, "escape") || data === "h") return done(undefined);
        if (matchesKey(data, "down") || data === "j") { index = (index + 1) % items.length; tui.requestRender(); return; }
        if (matchesKey(data, "up") || data === "k") { index = (index - 1 + items.length) % items.length; tui.requestRender(); return; }
        if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "l") done(items[index].mode);
      },
    };
  });
}

export default function blinkExtension(pi: ExtensionAPI): void {
  let selectedMode: BlinkMode = "off";
  let activeRunMode: BlinkMode | undefined;
  let runtime: BlinkRuntime | undefined;
  let currentCtx: ExtensionContext | undefined;
  const sinks = new Map<string, BlinkFeedbackSink>();

  const updateStatus = (ctx: ExtensionContext) => {
    if (selectedMode === "off") ctx.ui.setStatus(STATUS_KEY, undefined);
    else if (selectedMode === "slow") ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", "blink:slow"));
    else ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", `blink:blitz ${runtime?.retainedCount ?? 0}`));
  };

  const closeRuntime = async () => {
    const old = runtime;
    runtime = undefined;
    await old?.cleanup();
  };

  const createRuntime = (ctx: ExtensionContext, mode: "slow" | "blitz") => {
    const ownerPane = process.env.TMUX_PANE || "";
    runtime = new BlinkRuntime({
      mode,
      cwd: ctx.cwd,
      ownerPane,
      reviewScript,
      pi,
      queueMutation: withFileMutationQueue,
      sinks,
    });
    runtime.setContext(ctx);
  };

  const requireRuntime = (ctx: ExtensionContext, mode: "slow" | "blitz"): BlinkRuntime => {
    if (!runtime || runtime.mode !== mode) createRuntime(ctx, mode);
    runtime!.setContext(ctx);
    return runtime!;
  };

  const checkRequirements = async (ctx: ExtensionCommandContext): Promise<string | undefined> => {
    if (ctx.mode !== "tui") return "Blink Slow and Blitz require Pi TUI mode.";
    if (!process.env.TMUX) return "Blink requires Pi to run inside tmux (TMUX is missing).";
    if (!process.env.TMUX_PANE) return "Blink cannot identify the Pi pane (TMUX_PANE is missing).";
    for (const command of ["tmux", "nvim"]) {
      const result = await pi.exec("sh", ["-lc", `command -v ${command}`]);
      if (result.code !== 0) return `Blink requires '${command}' on PATH.`;
    }
    try { await access(reviewScript); } catch { return `Blink Neovim client is missing: ${reviewScript}`; }
    return undefined;
  };

  pi.events.on("blink:sink:register", (data) => {
    const sink = data as BlinkFeedbackSink;
    if (sink && typeof sink.id === "string" && typeof sink.label === "string" && typeof sink.submit === "function") {
      sinks.set(sink.id, sink);
      runtime?.sinksChanged();
    }
  });
  pi.events.on("blink:sink:unregister", (data) => {
    const id = typeof data === "string" ? data : (data as { id?: unknown })?.id;
    if (typeof id === "string") {
      sinks.delete(id);
      runtime?.sinksChanged();
    }
  });

  pi.registerCommand("blink", {
    description: "Select Off, Slow, or Blitz human file review mode",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") { ctx.ui.notify("The /blink picker requires Pi TUI mode.", "error"); return; }
      if (!ctx.isIdle()) { ctx.ui.notify("Blink mode cannot change while Pi is running.", "warning"); return; }
      const choice = await pickMode(ctx, selectedMode);
      if (!choice || choice === selectedMode) return;
      if (choice !== "off") {
        const failure = await checkRequirements(ctx);
        if (failure) { ctx.ui.notify(failure, "error"); return; }
      }
      await closeRuntime();
      selectedMode = choice;
      activeRunMode = undefined;
      pi.appendEntry(MODE_ENTRY, { mode: choice });
      if (choice !== "off") createRuntime(ctx, choice);
      updateStatus(ctx);
      ctx.ui.notify(`Blink mode: ${choice}`, "info");
    },
  });

  const tools = createBlinkToolDefinitions({
    initialCwd: process.cwd(),
    getMode: () => activeRunMode ?? selectedMode,
    createEditDefinition: (cwd, options) => createEditToolDefinition(cwd, options) as any,
    createWriteDefinition: (cwd, options) => createWriteToolDefinition(cwd, options) as any,
    runSlow: (input) => requireRuntime(input.ctx as ExtensionContext, "slow").runSlow(input as any),
    prepareBlitzMutation: (path, ctx) => requireRuntime(ctx as ExtensionContext, "blitz").prepareMutation(path),
    discardBlitzMutation: (preparation) => runtime?.discardMutation(preparation),
    enqueueBlitzVersion: (input) => requireRuntime(input.ctx as ExtensionContext, "blitz").enqueueVersion(input as any),
  });
  pi.registerTool(tools.edit as any);
  pi.registerTool(tools.write as any);

  pi.on("session_start", async (event, ctx) => {
    currentCtx = ctx;
    await closeRuntime();
    activeRunMode = undefined;
    const defaultMode: BlinkMode = ctx.mode === "tui" && process.env.TMUX && process.env.TMUX_PANE ? "blitz" : "off";
    if (event.reason === "new" || event.reason === "fork") {
      selectedMode = defaultMode;
      pi.appendEntry(MODE_ENTRY, { mode: selectedMode });
    } else {
      selectedMode = restoreMode(ctx, defaultMode);
    }
    if (selectedMode !== "off" && ctx.mode === "tui" && process.env.TMUX && process.env.TMUX_PANE) createRuntime(ctx, selectedMode);
    updateStatus(ctx);
    pi.events.emit("blink:sinks:discover", { reviewId: runtime?.reviewId });
  });

  pi.on("agent_start", (_event, ctx) => {
    currentCtx = ctx;
    if (activeRunMode === undefined) activeRunMode = selectedMode;
    runtime?.agentStarted(ctx);
  });
  pi.on("agent_settled", (_event, ctx) => {
    currentCtx = ctx;
    activeRunMode = undefined;
    updateStatus(ctx);
  });
  pi.on("session_shutdown", async () => {
    currentCtx = undefined;
    activeRunMode = undefined;
    await closeRuntime();
  });
}
