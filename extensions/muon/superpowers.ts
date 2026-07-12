import { resolveEnabledSkillPaths, skillsetToSkillIds } from "./skills.js";
import type { MuonSkillset, MuonState } from "./types.js";

export function getSkillsetPaths(skillset: MuonSkillset): string[] {
  return resolveEnabledSkillPaths(skillsetToSkillIds(skillset)).skillPaths;
}

export function discoverSuperpowersResources(state: MuonState): {
  skillPaths?: string[];
} {
  const { skillPaths } = resolveEnabledSkillPaths(state.config.enabledSkills);
  return skillPaths.length > 0 ? { skillPaths } : {};
}
