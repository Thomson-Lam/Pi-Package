import { MUON_PONYTAIL_SKILLS_DIR } from "./constants.js";

export function resolveMuonSubagentSkill(name: string): string {
  switch (name.trim()) {
    case "ponytail":
      return MUON_PONYTAIL_SKILLS_DIR;
    default:
      throw new Error(`Unknown Muon subagent skill: ${name}`);
  }
}
