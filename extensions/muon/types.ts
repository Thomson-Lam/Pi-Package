export type SuperpowersMode = "off" | "discover" | "bootstrap";
export type AgentScope = "user" | "project" | "both";
export type WorkflowPhaseKind = "single" | "parallel" | "chain";
export type WorktreeMode = "none" | "shared-run";

export interface MuonConfig {
  superpowersMode: SuperpowersMode;
  superpowersSkillsPath?: string;
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
  injectBootstrapThisSession: boolean;
}

export interface MuonPersistedState extends MuonState {
  updatedAt: number;
}
