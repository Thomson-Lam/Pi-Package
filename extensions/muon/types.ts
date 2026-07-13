export type MuonSkillset = "off" | "auto" | "ponytail" | "superpowers";
export type MuonSkillId =
  | "ponytail"
  | "superpowers"
  | "cindex"
  | "handoff"
  | "ipynb-toolshed"
  | "yagni-scope-guard";
export interface MuonConfig {
  /** Legacy profile field kept for old session entries and `/muon skillset` compatibility. */
  skillset: MuonSkillset;
  /** Muon-governed skill/profile ids exposed through resources_discover. */
  enabledSkills: MuonSkillId[];
}

export interface MuonState {
  config: MuonConfig;
}

export interface MuonPersistedState extends MuonState {
  updatedAt: number;
}
