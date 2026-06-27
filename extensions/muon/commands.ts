import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MuonState, SuperpowersMode } from "./types.js";

export interface MuonDeps {
  getState: () => MuonState;
  setState: (updater: (draft: MuonState) => void, ctx: ExtensionContext) => void;
}

function isSuperpowersMode(value: string): value is SuperpowersMode {
  return value === "off" || value === "discover" || value === "bootstrap";
}

function showStatus(ctx: ExtensionCommandContext, state: MuonState): void {
  const active = state.activeRunId ? state.runs[state.activeRunId] : undefined;
  ctx.ui.notify(
    [
      "Muon status",
      `skills: ${state.config.superpowersMode}`,
      `skills path: ${state.config.superpowersSkillsPath ?? "—"}`,
      `maxParallel: ${state.config.maxParallel}`,
      `maxDepth: ${state.config.maxDepth}`,
      `agentScope: ${state.config.defaultAgentScope}`,
      `worktreeMode: ${state.config.worktreeMode}`,
      `activeRun: ${active ? `${active.runId} ${active.status} ${active.name}` : "—"}`,
    ].join("\n"),
    "info",
  );
}

export function registerMuonCommands(pi: ExtensionAPI, deps: MuonDeps): void {
  pi.registerCommand("muon", {
    description: "Muon control: /muon status | /muon skills off|discover|bootstrap|status",
    handler: async (args, ctx) => {
      const words = args.trim().split(/\s+/).filter(Boolean);
      const state = deps.getState();
      if (words.length === 0 || words[0] === "status") {
        showStatus(ctx, state);
        return;
      }

      if (words[0] === "skills") {
        const action = words[1] ?? "status";
        if (action === "status") {
          ctx.ui.notify(`Superpowers mode: ${state.config.superpowersMode}\nPath: ${state.config.superpowersSkillsPath ?? "—"}`, "info");
          return;
        }
        if (!isSuperpowersMode(action)) throw new Error("Usage: /muon skills off|discover|bootstrap|status");
        deps.setState((draft) => {
          draft.config.superpowersMode = action;
          draft.injectBootstrapThisSession = true;
        }, ctx);
        ctx.ui.notify(`Muon Superpowers mode set to ${action}. Run /reload if skill discovery paths changed.`, "success");
        return;
      }

      if (words[0] === "agents") {
        const requested = (words[1] ?? state.config.defaultAgentScope) as "user" | "project" | "both";
        if (requested !== "user" && requested !== "project" && requested !== "both") {
          throw new Error("Usage: /muon agents [user|project|both]");
        }
        const { discoverMuonAgents } = await import("./agents.js");
        const discovery = discoverMuonAgents(ctx.cwd, requested);
        const lines = discovery.agents.map((a) => `- ${a.name} (${a.source}) ${a.model ? `[${a.model}] ` : ""}${a.description}`);
        ctx.ui.notify(lines.length > 0 ? `Muon agents (${requested}):\n${lines.join("\n")}` : `No agents found for scope ${requested}`, "info");
        return;
      }

      if (words[0] === "subagent") {
        const template = JSON.stringify({ agent: "scout", task: "Describe what to inspect", agentScope: state.config.defaultAgentScope, maxParallel: state.config.maxParallel, maxDepth: state.config.maxDepth }, null, 2);
        const edited = await ctx.ui.editor("muon_subagent JSON", template);
        if (!edited?.trim()) return;
        pi.sendUserMessage(`Call muon_subagent with this JSON exactly:\n\n\`\`\`json\n${edited.trim()}\n\`\`\``);
        return;
      }

      if (words[0] === "workflow") {
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

      if (words[0] === "rollback") {
        const runId = words[1] ?? state.activeRunId;
        if (!runId || !state.runs[runId]) throw new Error("Usage: /muon rollback <runId>");
        const run = state.runs[runId];
        if (!run.worktreePath) throw new Error(`Run ${runId} has no worktreePath`);
        const targetRef = words[2] ?? "HEAD~1";
        const { rollbackMuonWorktree } = await import("./worktree.js");
        const ok = await ctx.ui.confirm("Rollback Muon worktree", `Run: ${runId}\nWorktree: ${run.worktreePath}\nTarget: ${targetRef}`);
        if (!ok) return;
        await rollbackMuonWorktree(pi as any, run.worktreePath, targetRef);
        ctx.ui.notify(`Rolled back ${runId} to ${targetRef}`, "success");
        return;
      }

      if (words[0] === "runs") {
        const runs = Object.values(state.runs).sort((a, b) => b.startedAt - a.startedAt);
        if (runs.length === 0) { ctx.ui.notify("No Muon runs in this session", "info"); return; }
        ctx.ui.notify(runs.map((r) => `${r.runId} ${r.status} ${r.name}\n  ${r.ledgerPath}`).join("\n"), "info");
        return;
      }

      if (words[0] === "open") {
        const runId = words[1] ?? state.activeRunId;
        if (!runId || !state.runs[runId]) throw new Error("Usage: /muon open <runId>");
        const run = state.runs[runId];
        await ctx.ui.editor(`Muon run ${runId}`, `Ledger: ${run.ledgerPath}\nRun dir: ${run.runDir}\nWorkflow: ${run.workflowPath ?? "—"}\nWorktree: ${run.worktreePath ?? "—"}\n`);
        return;
      }

      throw new Error("Usage: /muon status | /muon skills off|discover|bootstrap|status");
    },
  });
}
