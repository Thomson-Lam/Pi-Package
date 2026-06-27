import { MUON_SKILLS_DIR } from "./constants.js";
import type { MuonState } from "./types.js";

export function discoverSuperpowersResources(state: MuonState): { skillPaths?: string[] } {
  if (state.config.superpowersMode !== "on") return {};
  return { skillPaths: [MUON_SKILLS_DIR] };
}
