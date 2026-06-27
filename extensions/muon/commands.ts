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

      throw new Error("Usage: /muon status | /muon skills off|discover|bootstrap|status");
    },
  });
}
