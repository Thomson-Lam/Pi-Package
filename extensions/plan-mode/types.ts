export interface PlanAttachmentState {
  planName: string;
  planPath: string;
  attachedHash: string;
  attachedAt: number;
  baselineContent: string;
  currentHash?: string;
  lastNotifiedHash?: string;
  lastDiffReadHash?: string;
}

export type PlanStoreMode = "global" | "repo";

export interface PlanLocation {
  name: string;
  path: string;
  kind: "store" | "explicitPath";
  createdAt: number;
  updatedAt: number;
}

export interface PlanModeState {
  enabled: boolean;
  currentPlanName?: string;
  activeSuModules: string[];
  planAttachments: Record<string, PlanAttachmentState>;
  activeAttachedPlanName?: string;
  planStoreMode: PlanStoreMode;
  planLocations: Record<string, PlanLocation>;
}

export interface PlanModePersistedState extends PlanModeState {
  updatedAt: number;
}

export interface PlanDescriptor {
  name: string;
  path: string;
  mtimeMs: number;
}

export interface PlanModeConfig {
  recentPlans: string[];
  planLocations: Record<string, PlanLocation>;
}
