import {
  MUON_PONYTAIL_SKILLS_DIR,
  MUON_ROUTER_SKILLS_DIR,
  MUON_SUPERPOWERS_SKILLS_DIR
} from "./constants.js";
import type { MuonSkillset, MuonState } from "./types.js";

export function getSkillsetPaths(skillset: MuonSkillset): string[] {
  switch (skillset) {
    case "off":
      return [];
    case "auto":
      return [
        MUON_ROUTER_SKILLS_DIR,
        MUON_PONYTAIL_SKILLS_DIR,
        MUON_SUPERPOWERS_SKILLS_DIR
      ];
    case "ponytail":
      return [MUON_ROUTER_SKILLS_DIR, MUON_PONYTAIL_SKILLS_DIR];
    case "superpowers":
      return [MUON_ROUTER_SKILLS_DIR, MUON_SUPERPOWERS_SKILLS_DIR];
  }
}

export function discoverSuperpowersResources(state: MuonState): {
  skillPaths?: string[];
} {
  const skillPaths = getSkillsetPaths(state.config.skillset);
  return skillPaths.length > 0 ? { skillPaths } : {};
}
