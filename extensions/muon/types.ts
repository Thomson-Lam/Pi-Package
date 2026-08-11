export type MuonMode = "off" | "build" | "spec";
export type MuonSkillProfile = "off" | "ponytail";
export type MuonSkillId =
  | "ponytail"
  | "authoring-skills"
  | "cindex"
  | "github-issues-prs"
  | "ipynb-toolshed"
  | "tmux-tdl-logs"
  | "yagni-product-design";

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
