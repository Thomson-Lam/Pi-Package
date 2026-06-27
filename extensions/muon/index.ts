import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerMuonCommands } from "./commands.js";
import { registerMuonTools } from "./tools.js";
import { createInitialMuonState, persistMuonState, restoreMuonState, updateMuonStatus } from "./state.js";
import { discoverSuperpowersResources, maybeInjectSuperpowersBootstrap, resetSuperpowersBootstrap } from "./superpowers.js";
import { renderMuonSubagentResult } from "./render.js";
import type { MuonState } from "./types.js";

export default async function muonExtension(pi: ExtensionAPI): Promise<void> {
  let state: MuonState = createInitialMuonState();

  const getState = () => state;
  const setState = (updater: (draft: MuonState) => void, ctx: ExtensionContext) => {
    updater(state);
    persistMuonState(pi, state);
    updateMuonStatus(ctx, state);
  };

  registerMuonCommands(pi, { getState, setState });
  registerMuonTools(pi, { getState, setState });

  pi.on("session_start", async (_event, ctx) => {
    state = restoreMuonState(ctx);
    resetSuperpowersBootstrap(state);
    updateMuonStatus(ctx, state);
  });

  pi.on("resources_discover", async () => discoverSuperpowersResources(state));

  pi.on("context", async (event) => maybeInjectSuperpowersBootstrap(event, state));

  pi.on("agent_end", async () => {
    state.injectBootstrapThisSession = false;
  });
}
