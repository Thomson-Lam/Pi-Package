import { readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerMuonCommands } from "./commands.js";
import { MUON_BUILD_PROMPT_PATH, MUON_SPEC_PROMPT_PATH, MUON_STATE_ENTRY_TYPE } from "./constants.js";
import { discoverMuonResources } from "./resources.js";
import { selectModeSkillIds } from "./skills.js";
import { createInitialMuonState, persistMuonState, restoreMuonState, updateMuonStatus } from "./state.js";
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

/**
 * Spec mode: replace only the role sentence of Pi's default system prompt
 * with spec-prompt.md, keeping the tools list, tool note, guidelines,
 * pi-docs block, skills catalog, and cwd intact. Sessions launched with a
 * custom system prompt (--system-prompt / SYSTEM.md) have no "Available
 * tools:" block; fall back to additive there.
 */
function buildSpecSystemPrompt(systemPrompt: string, specPrompt: string): string {
  const toolsIndex = systemPrompt.indexOf("Available tools:");
  if (toolsIndex < 0) return `${systemPrompt}\n\n${specPrompt}`;
  return `${specPrompt}\n\n${systemPrompt.slice(toolsIndex)}`;
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

  pi.registerCommand("off", {
    description: "Start a new session in Pi's default (minimal) mode, without build or spec prompts",
    handler: async (_args, ctx) => newSessionInMode("off", ctx),
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

  pi.on("resources_discover", async () => discoverMuonResources(state));

  pi.on("before_agent_start", (event) => {
    if (state.config.mode === "build") {
      // Additive: Pi's default system prompt (role, tools, guidelines) plus the build prompt.
      return { systemPrompt: `${event.systemPrompt}\n\n${buildPrompt}` };
    }
    if (state.config.mode === "spec") {
      // Role-splice: spec prompt stands in for the default role line; everything else stays.
      return { systemPrompt: buildSpecSystemPrompt(event.systemPrompt, specPrompt) };
    }
  });
}
