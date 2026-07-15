import { resolveEnabledSkillPaths } from "./skills.js";
import type { MuonState } from "./types.js";

export function discoverMuonResources(state: MuonState): {
  skillPaths?: string[];
} {
  const { skillPaths } = resolveEnabledSkillPaths(state.config.enabledSkills);
  return skillPaths.length > 0 ? { skillPaths } : {};
}
