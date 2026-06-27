import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import type { MuonState, SuperpowersMode } from "./types.js";

export interface MuonDeps {
  getState: () => MuonState;
  setState: (updater: (draft: MuonState) => void, ctx: ExtensionContext) => void;
}

const HELP_TEXT = `# /muon

Muon is a personal Pi extension for bundled skill-first workflows, transparent subagent orchestration, declarative workflows, worktree checkpoints, and rollback-aware monitoring.

## Actions

- Status — show Muon configuration and active run.
- Skills — turn Muon's bundled skill-first workflow on or off.
- Agents — list available agent definitions by scope (user / project / both).
- Subagent — open a JSON editor to draft a muon_subagent tool call.
- Workflow — open a JSON editor to draft a muon_workflow tool call.
- Runs — list Muon runs in this session.
- Open — open run summary for a given run ID.
- Rollback — roll back a shared-run worktree to a target ref.
- Help — show this help modal.

## Usage

\`/muon\` opens this menu. You can also invoke actions directly:

\`/muon status\`
\`/muon skills on|off|status\`
\`/muon agents [user|project|both]\`
\`/muon subagent\`
\`/muon workflow\`
\`/muon runs\`
\`/muon open [runId]\`
\`/muon rollback <runId> [targetRef]\`
\`/muon help\`

This help is rendered in a modal and is not injected into the current agent session.`;

type MuonAction =
  | { kind: "status" }
  | { kind: "skills"; mode?: "on" | "off" | "status" }
  | { kind: "agents"; scope?: "user" | "project" | "both" }
  | { kind: "subagent" }
  | { kind: "workflow" }
  | { kind: "runs" }
  | { kind: "open"; runId?: string }
  | { kind: "rollback"; runId?: string; targetRef?: string }
  | { kind: "help" };

type ParsedMuon = { kind: "menu" } | { kind: "action"; action: MuonAction } | { kind: "error"; message: string };

function isSuperpowersMode(value: string): value is SuperpowersMode {
  return value === "off" || value === "on";
}

function parseMuonAction(args: string): ParsedMuon {
  const normalized = args.trim().toLowerCase().replace(/\s+/g, " ");
  if (!normalized) return { kind: "menu" };

  const [verb, ...rest] = normalized.split(" ");

  if (verb === "help" || verb === "h" || verb === "?") return { kind: "action", action: { kind: "help" } };
  if (verb === "status") return { kind: "action", action: { kind: "status" } };
  if (verb === "runs") return { kind: "action", action: { kind: "runs" } };
  if (verb === "subagent") return { kind: "action", action: { kind: "subagent" } };
  if (verb === "workflow") return { kind: "action", action: { kind: "workflow" } };

  if (verb === "skills") {
    const mode = rest[0];
    if (!mode) return { kind: "action", action: { kind: "skills" } };
    if (mode === "status") return { kind: "action", action: { kind: "skills", mode: "status" } };
    if (!isSuperpowersMode(mode)) return { kind: "error", message: "Usage: /muon skills on|off|status" };
    return { kind: "action", action: { kind: "skills", mode } };
  }

  if (verb === "agents") {
    const scope = rest[0] as "user" | "project" | "both" | undefined;
    if (scope && scope !== "user" && scope !== "project" && scope !== "both") {
      return { kind: "error", message: "Usage: /muon agents [user|project|both]" };
    }
    return { kind: "action", action: { kind: "agents", scope } };
  }

  if (verb === "open") return { kind: "action", action: { kind: "open", runId: rest[0] } };
  if (verb === "rollback") return { kind: "action", action: { kind: "rollback", runId: rest[0], targetRef: rest[1] } };

  return { kind: "error", message: "Usage: /muon [status|skills|agents|subagent|workflow|runs|open|rollback|help]" };
}

async function selectModal(ctx: ExtensionCommandContext, title: string, items: SelectItem[]): Promise<string | undefined> {
  const result = await ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));

    const selectList = new SelectList(items, Math.min(items.length, 12), {
      selectedPrefix: (text: string) => theme.fg("accent", text),
      selectedText: (text: string) => theme.fg("accent", text),
      description: (text: string) => theme.fg("muted", text),
      scrollInfo: (text: string) => theme.fg("dim", text),
      noMatch: (text: string) => theme.fg("warning", text),
    });
    selectList.onSelect = (item) => done(item.value);
    selectList.onCancel = () => done(undefined);
    container.addChild(selectList);
    container.addChild(new Text(theme.fg("dim", "↑↓/j/k navigate • enter select • h help • esc cancel"), 1, 0));
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        if (data === "h" || data === "H" || data === "?") {
          done("help");
          return;
        }
        if (data === "j" || data === "J") selectList.handleInput("\x1b[B");
        else if (data === "k" || data === "K") selectList.handleInput("\x1b[A");
        else selectList.handleInput(data);
        tui.requestRender();
      },
    };
  });
  return result;
}

async function pickMuonAction(ctx: ExtensionCommandContext): Promise<MuonAction | undefined> {
  const selected = await selectModal(ctx, "Muon", [
    { value: "status", label: "Status", description: "Show Muon configuration and active run" },
    { value: "skills", label: "Skills", description: "Turn bundled skill-first workflow on/off" },
    { value: "agents", label: "Agents", description: "List available agents" },
    { value: "subagent", label: "Subagent", description: "Draft a muon_subagent tool call" },
    { value: "workflow", label: "Workflow", description: "Draft a muon_workflow tool call" },
    { value: "runs", label: "Runs", description: "List Muon runs" },
    { value: "open", label: "Open", description: "Open active run summary" },
    { value: "rollback", label: "Rollback", description: "Rollback active shared-run worktree" },
    { value: "help", label: "Help", description: "Show Muon help" },
  ]);
  if (!selected) return undefined;
  if (selected === "open") return { kind: "open" };
  if (selected === "rollback") return { kind: "rollback" };
  return { kind: selected as MuonAction["kind"] };
}

async function pickMuonSkillsAction(ctx: ExtensionCommandContext, state: MuonState): Promise<MuonAction | undefined> {
  const selected = await selectModal(ctx, `Muon Skills (${state.config.superpowersMode})`, [
    {
      value: "on",
      label: state.config.superpowersMode === "on" ? "On ✓" : "On",
      description: "Expose bundled skills and inject using-superpowers once per session",
    },
    {
      value: "off",
      label: state.config.superpowersMode === "off" ? "Off ✓" : "Off",
      description: "Disable bundled skill discovery and bootstrap injection",
    },
  ]);
  if (!selected) return undefined;
  return { kind: "skills", mode: selected as "on" | "off" };
}

async function showMuonHelp(ctx: ExtensionCommandContext): Promise<void> {
  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) => {
      const container = new Container();
      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
      container.addChild(new Text(theme.fg("accent", theme.bold("Muon Help")), 1, 0));
      container.addChild(new Text(HELP_TEXT, 1, 1));
      container.addChild(new Text(theme.fg("dim", "Press Enter or Esc to dismiss"), 1, 0));
      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
      return {
        render: (width: number) => container.render(width),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => {
          if (data === "\r" || data === "\n" || data === "\x1b") done();
          tui.requestRender();
        },
      };
    },
    { overlay: true, overlayOptions: { width: "80%", maxHeight: "80%", margin: 2 } },
  );
}

async function runMuonAction(pi: ExtensionAPI, deps: MuonDeps, ctx: ExtensionCommandContext, action: MuonAction): Promise<void> {
  const state = deps.getState();

  if (action.kind === "help") return showMuonHelp(ctx);

  if (action.kind === "status") {
    const active = state.activeRunId ? state.runs[state.activeRunId] : undefined;
    ctx.ui.notify(
      [
        "Muon status",
        `skills: ${state.config.superpowersMode}`,
        `skills source: bundled Muon skills`,
        `maxParallel: ${state.config.maxParallel}`,
        `maxDepth: ${state.config.maxDepth}`,
        `agentScope: ${state.config.defaultAgentScope}`,
        `worktreeMode: ${state.config.worktreeMode}`,
        `activeRun: ${active ? `${active.runId} ${active.status} ${active.name}` : "—"}`,
      ].join("\n"),
      "info",
    );
    return;
  }

  if (action.kind === "skills") {
    const mode = action.mode;
    if (!mode) {
      const picked = await pickMuonSkillsAction(ctx, state);
      if (!picked) return;
      await runMuonAction(pi, deps, ctx, picked);
      return;
    }
    if (mode === "status") {
      ctx.ui.notify(`Muon skills mode: ${state.config.superpowersMode}\nSource: bundled extensions/muon/skills`, "info");
      return;
    }
    deps.setState((draft) => {
      draft.config.superpowersMode = mode;
      draft.injectBootstrapThisSession = true;
    }, ctx);
    ctx.ui.notify(
      mode === "on"
        ? "Muon skills mode set to on. Skill-first bootstrap will be injected on your next prompt."
        : "Muon skills mode set to off. Bundled skills remain discoverable, but bootstrap injection is disabled.",
      "success",
    );
    return;
  }

  if (action.kind === "agents") {
    const requested = action.scope ?? state.config.defaultAgentScope;
    const { discoverMuonAgents } = await import("./agents.js");
    const discovery = discoverMuonAgents(ctx.cwd, requested);
    const lines = discovery.agents.map((a) => `- ${a.name} (${a.source}) ${a.model ? `[${a.model}] ` : ""}${a.description}`);
    ctx.ui.notify(lines.length > 0 ? `Muon agents (${requested}):\n${lines.join("\n")}` : `No agents found for scope ${requested}`, "info");
    return;
  }

  if (action.kind === "subagent") {
    const template = JSON.stringify({ agent: "scout", task: "Describe what to inspect", agentScope: state.config.defaultAgentScope, maxParallel: state.config.maxParallel, maxDepth: state.config.maxDepth }, null, 2);
    const edited = await ctx.ui.editor("muon_subagent JSON", template);
    if (!edited?.trim()) return;
    pi.sendUserMessage(`Call muon_subagent with this JSON exactly:\n\n\`\`\`json\n${edited.trim()}\n\`\`\``);
    return;
  }

  if (action.kind === "workflow") {
    const template = JSON.stringify({
      name: "example-workflow",
      objective: "Describe the goal",
      maxParallel: state.config.maxParallel,
      maxDepth: state.config.maxDepth,
      phases: [
        { id: "scout", title: "Inspect relevant files", kind: "single", agent: "scout", task: "Find relevant files and summarize architecture." },
        { id: "review", title: "Review findings", kind: "single", agent: "reviewer", task: "Review the scout findings and list risks." }
      ]
    }, null, 2);
    const edited = await ctx.ui.editor("muon_workflow JSON", template);
    if (!edited?.trim()) return;
    pi.sendUserMessage(`Call muon_workflow with this JSON exactly:\n\n\`\`\`json\n${edited.trim()}\n\`\`\``);
    return;
  }

  if (action.kind === "runs") {
    const runs = Object.values(state.runs).sort((a, b) => b.startedAt - a.startedAt);
    if (runs.length === 0) { ctx.ui.notify("No Muon runs in this session", "info"); return; }
    ctx.ui.notify(runs.map((r) => `${r.runId} ${r.status} ${r.name}\n  ${r.ledgerPath}`).join("\n"), "info");
    return;
  }

  if (action.kind === "open") {
    const runId = action.runId ?? state.activeRunId;
    if (!runId || !state.runs[runId]) {
      ctx.ui.notify("Usage: /muon open <runId>", "error");
      return;
    }
    const run = state.runs[runId];
    await ctx.ui.editor(`Muon run ${runId}`, `Ledger: ${run.ledgerPath}\nRun dir: ${run.runDir}\nWorkflow: ${run.workflowPath ?? "—"}\nWorktree: ${run.worktreePath ?? "—"}\n`);
    return;
  }

  if (action.kind === "rollback") {
    const runId = action.runId ?? state.activeRunId;
    if (!runId || !state.runs[runId]) { ctx.ui.notify("Usage: /muon rollback <runId>", "error"); return; }
    const run = state.runs[runId];
    if (!run.worktreePath) { ctx.ui.notify(`Run ${runId} has no worktreePath`, "error"); return; }
    const targetRef = action.targetRef ?? "HEAD~1";
    const { rollbackMuonWorktree } = await import("./worktree.js");
    const ok = await ctx.ui.confirm("Rollback Muon worktree", `Run: ${runId}\nWorktree: ${run.worktreePath}\nTarget: ${targetRef}`);
    if (!ok) return;
    await rollbackMuonWorktree(pi as any, run.worktreePath, targetRef);
    ctx.ui.notify(`Rolled back ${runId} to ${targetRef}`, "success");
    return;
  }
}

export function registerMuonCommands(pi: ExtensionAPI, deps: MuonDeps): void {
  pi.registerCommand("muon", {
    description: "Open Muon menu",
    getArgumentCompletions: (prefix) => {
      const items = ["status", "skills", "agents", "subagent", "workflow", "runs", "open", "rollback", "help"];
      return items.filter((item) => item.startsWith(prefix.trimStart())).map((value) => ({ value, label: value }));
    },
    handler: async (args, ctx) => {
      const parsed = parseMuonAction(args || "");
      if (parsed.kind === "error") {
        ctx.ui.notify(parsed.message, "error");
        return;
      }
      const action = parsed.kind === "menu" ? await pickMuonAction(ctx) : parsed.action;
      if (!action) return;
      await runMuonAction(pi, deps, ctx, action);
    },
  });
}
