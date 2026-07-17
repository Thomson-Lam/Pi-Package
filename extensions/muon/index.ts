import { readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerMuonCommands } from "./commands.js";
import { MUON_BUILD_PROMPT_PATH, MUON_SPEC_PROMPT_PATH, MUON_STATE_ENTRY_TYPE } from "./constants.js";
import { discoverMuonResources } from "./resources.js";
import { selectModeSkillIds } from "./skills.js";
import { createInitialMuonState, persistMuonState, restoreMuonState, updateMuonStatus } from "./state.js";
import registerHandoffContinuation from "./handoff-continuation.js";
import registerTmuxTdlLogs from "./skillsets/standalone/tmux-tdl-logs/extension.js";
import type { MuonMode, MuonState } from "./types.js";

const buildPrompt = readFileSync(MUON_BUILD_PROMPT_PATH, "utf8");
const specPrompt = readFileSync(MUON_SPEC_PROMPT_PATH, "utf8");

function isMuonMode(value: string): value is MuonMode {
  return value === "off" || value === "build" || value === "spec";
}

function applyMuonMode(state: MuonState, mode: MuonMode): void {
  state.config.mode = mode;
  state.config.enabledSkills = selectModeSkillIds(state.config.enabledSkills, mode);
}

export default async function muonExtension(pi: ExtensionAPI): Promise<void> {
  let state: MuonState = createInitialMuonState();

  pi.registerFlag("muon-mode", {
    description: "Start Muon in a mode: off, build, or spec",
    type: "string",
  });

  const getState = () => state;
  const setState = (updater: (draft: MuonState) => void, ctx: ExtensionContext) => {
    updater(state);
    persistMuonState(pi, state);
    updateMuonStatus(ctx, state);
  };

  registerMuonCommands(pi, { getState, setState });

  async function newSessionInMode(mode: MuonMode, ctx: ExtensionCommandContext): Promise<void> {
    const nextState: MuonState = {
      config: {
        mode: state.config.mode,
        enabledSkills: [...state.config.enabledSkills],
      },
    };
    applyMuonMode(nextState, mode);

    await ctx.newSession({
      parentSession: ctx.sessionManager.getSessionFile(),
      setup: async (sessionManager) => {
        sessionManager.appendCustomEntry(MUON_STATE_ENTRY_TYPE, {
          ...nextState,
          updatedAt: Date.now(),
        });
      },
    });
  }

  pi.registerCommand("build", {
    description: "Start a new session in Muon build mode",
    handler: async (_args, ctx) => newSessionInMode("build", ctx),
  });

  pi.registerCommand("spec", {
    description: "Start a new session in Muon spec mode",
    handler: async (_args, ctx) => newSessionInMode("spec", ctx),
  });

  pi.on("session_start", async (event, ctx) => {
    state = restoreMuonState(ctx);

    const startupMode = pi.getFlag("muon-mode");
    if (event.reason === "startup" && typeof startupMode === "string" && startupMode.trim()) {
      const mode = startupMode.trim().toLowerCase();
      if (isMuonMode(mode)) {
        applyMuonMode(state, mode);
        persistMuonState(pi, state);
      } else {
        ctx.ui.notify(`Invalid --muon-mode: ${startupMode}. Expected off, build, or spec.`, "warning");
      }
    }

    updateMuonStatus(ctx, state);
  });

  registerTmuxTdlLogs(pi, () => state.config.enabledSkills.includes("tmux-tdl-logs"));
  registerHandoffContinuation(pi, () => state.config.enabledSkills.includes("handoff"));

  pi.on("resources_discover", async () => discoverMuonResources(state));

  pi.on("before_agent_start", (event) => {
    const prompt = state.config.mode === "build"
      ? buildPrompt
      : state.config.mode === "spec"
        ? specPrompt
        : undefined;
    if (!prompt) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${prompt}` };
  });
}
