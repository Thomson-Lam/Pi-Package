export type MuonSkillset = "off" | "auto" | "ponytail" | "superpowers";
export type MuonSkillId =
  | "ponytail"
  | "superpowers"
  | "cindex"
  | "handoff"
  | "ipynb-toolshed"
  | "yagni-scope-guard";
export type AgentScope = "user" | "project" | "both";
export type WorkflowPhaseKind = "single" | "parallel" | "chain";
export type WorktreeMode = "none" | "shared-run";

export interface MuonConfig {
  /** Legacy profile field kept for old session entries and `/muon skillset` compatibility. */
  skillset: MuonSkillset;
  /** Muon-governed skill/profile ids exposed through resources_discover. */
  enabledSkills: MuonSkillId[];
  maxParallel: number;
  maxDepth: number;
  defaultAgentScope: AgentScope;
  worktreeMode: WorktreeMode;
}

export interface MuonRunSummary {
  runId: string;
  name: string;
  status: "running" | "succeeded" | "failed" | "aborted";
  startedAt: number;
  updatedAt: number;
  runDir: string;
  ledgerPath: string;
  workflowPath?: string;
  worktreePath?: string;
  branchName?: string;
  currentPhaseId?: string;
}

export interface MuonState {
  config: MuonConfig;
  activeRunId?: string;
  runs: Record<string, MuonRunSummary>;
}

export interface MuonPersistedState extends MuonState {
  updatedAt: number;
}
