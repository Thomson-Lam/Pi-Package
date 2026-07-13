import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerMuonCommands } from "./commands.js";
import { createInitialMuonState, persistMuonState, restoreMuonState, updateMuonStatus } from "./state.js";
import { discoverSuperpowersResources } from "./superpowers.js";
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

  pi.on("session_start", async (_event, ctx) => {
    state = restoreMuonState(ctx);
    updateMuonStatus(ctx, state);
  });

  pi.on("resources_discover", async () => discoverSuperpowersResources(state));
}
