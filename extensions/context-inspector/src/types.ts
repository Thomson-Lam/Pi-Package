export type ContextItemType =
  | "systemPrompt"
  | "contextFile"
  | "skill"
  | "userMessage"
  | "assistantMessage"
  | "toolCall"
  | "toolResult"
  | "readFile"
  | "compactionSummary"
  | "branchSummary"
  | "customMessage";

export type ContextItemStatus =
  | "active"
  | "likely-active"
  | "historical"
  | "summarized"
  | "system";

export interface ContextItem {
  id: string;
  type: ContextItemType;
  order: number;
  title: string;
  sourceLabel: string;
  path?: string;
  status: ContextItemStatus;
  includedReason: string;
  preview: string;
  contentText?: string;
  metadata?: {
    toolCallId?: string;
    messageRole?: string;
    timestamp?: number | string;
    skillName?: string;
    customType?: string;
    tokenEstimate?: number;
    parentEntryId?: string;
    readCount?: number;
    offset?: number;
    limit?: number;
    args?: unknown;
    details?: unknown;
    isError?: boolean;
  };
}

export interface ContextFileSnapshot {
  path: string;
  content?: string;
}

export interface SkillSnapshot {
  name: string;
  filePath: string;
  description?: string;
}

export interface SystemPromptOptionsSnapshot {
  contextFiles: ContextFileSnapshot[];
  skills: SkillSnapshot[];
}

export interface ReadEvent {
  id: string;
  path: string;
  offset?: number;
  limit?: number;
  timestamp: number;
  turnIndexHint?: number;
  toolCallId?: string;
  resultPreview?: string;
  resultContent?: string;
  resultLength?: number;
  isError?: boolean;
}

export type InspectorMode = "summary" | "list" | "detail";
export type InspectorDensity = "logical" | "verbose";

export interface InspectorState {
  lastSystemPrompt?: string;
  lastSystemPromptOptions?: SystemPromptOptionsSnapshot;
  readEvents: ReadEvent[];
  lastReconstructed: ContextItem[];
  panelOpen: boolean;
  selectedIndex: number;
  detailItemId?: string;
  mode: InspectorMode;
  density: InspectorDensity;
  filter: string;
}

export interface ContextCounts {
  total: number;
  systemPrompt: number;
  contextFile: number;
  skill: number;
  readFile: number;
  userMessage: number;
  assistantMessage: number;
  toolCall: number;
  toolResult: number;
  compactionSummary: number;
  branchSummary: number;
  customMessage: number;
  active: number;
  system: number;
  summarized: number;
  historical: number;
  likelyActive: number;
}
