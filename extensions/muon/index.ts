import { readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerMuonCommands } from "./commands.js";
import { MUON_BUILD_PROMPT_PATH, MUON_SPEC_PROMPT_PATH } from "./constants.js";
import { discoverMuonResources } from "./resources.js";
import { createInitialMuonState, persistMuonState, restoreMuonState, updateMuonStatus } from "./state.js";
import type { MuonState } from "./types.js";

const buildPrompt = readFileSync(MUON_BUILD_PROMPT_PATH, "utf8");
const specPrompt = readFileSync(MUON_SPEC_PROMPT_PATH, "utf8");

export default async function muonExtension(pi: ExtensionAPI): Promise<void> {
  let state: MuonState = createInitialMuonState();

  const getState = () => state;
  const setState = (updater: (draft: MuonState) => void, ctx: ExtensionContext) => {
    updater(state);
    persistMuonState(pi, state);
    updateMuonStatus(ctx, state);
  };

  registerMuonCommands(pi, { getState, setState });

  pi.on("session_start", async (_event, ctx) => {
    state = restoreMuonState(ctx);
    updateMuonStatus(ctx, state);
  });

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
