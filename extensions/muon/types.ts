export type MuonMode = "off" | "engineering" | "foundation";
export type MuonSkillProfile = "off" | "ponytail" | "engineering" | "foundation";
export type MuonSkillId =
  | "ponytail"
  | "engineering"
  | "foundation"
  | "authoring-skills"
  | "cindex"
  | "handoff"
  | "ipynb-toolshed"
  | "tmux-tdl-logs";

export interface MuonConfig {
  /** Active system-prompt mode. Mode changes also synchronize their skill bundle. */
  mode: MuonMode;
  /** Muon-governed skill/profile ids exposed through resources_discover. */
  enabledSkills: MuonSkillId[];
}

export interface MuonState {
  config: MuonConfig;
}

export interface MuonPersistedState extends MuonState {
  updatedAt: number;
}
