/**
 * types.ts — Type definitions for the agent-session system.
 *
 * Agents now run as native Pi sessions in their own tmux windows (see
 * REVIEW-UX-SPEC.md and AGENTS.md). The parent coordinates via a filesystem
 * mailbox; it no longer owns an in-process AgentSession.
 */

import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ContextLedgerNode } from "./context-ledger.js";
import type { LifetimeUsage } from "./usage.js";

export type ThinkingLevel = ModelThinkingLevel;

/** Agent type: any string name (built-in defaults or user-defined). */
export type SubagentType = string;

/** Memory scope for persistent agent memory. */
export type MemoryScope = "user" | "project" | "local";

/** Unified agent configuration — used for both default and user-defined agents. */
export interface AgentConfig {
  name: string;
  displayName?: string;
  description: string;
  /** Legacy metadata retained for custom-agent compatibility; launch uses parent tools exactly. */
  builtinToolNames?: string[];
  extSelectors?: string[];
  disallowedTools?: string[];
  /** Legacy metadata retained for custom-agent compatibility; launch uses parent extensions exactly. */
  extensions: true | string[] | false;
  excludeExtensions?: string[];
  /** true = inherit all, string[] = only listed, false = none */
  skills: true | string[] | false;
  model?: string;
  thinking?: ThinkingLevel;
  maxTurns?: number;
  systemPrompt: string;
  /** Default for spawn: run in background. undefined = caller decides. */
  runInBackground?: boolean;
  /** Persistent memory scope — agents with memory get a persistent directory and MEMORY.md */
  memory?: MemoryScope;
  /** true = this is an embedded default agent (informational) */
  isDefault?: boolean;
  /** false = agent is hidden from the registry */
  enabled?: boolean;
  /** Where this agent was loaded from */
  source?: "default" | "project" | "global";
}

export type JoinMode = 'async' | 'group' | 'smart';

/**
 * Fully serializable launch specification handed to child-host.mjs. No
 * functions, no Model objects, no secrets — the child resolves authentication
 * through its own credential store.
 */
export interface AgentLaunchSpec {
  version: 3;
  agent: {
    id: string;
    type: string;
    displayName: string;
    description: string;
  };
  session: {
    id: string;
    name: string;
    parentFile?: string;
    /** Session directory for the child file; absent = pi's default for the child cwd. */
    sessionDir?: string;
    /** When set, the child OPENS this existing session file instead of creating a new one. */
    openFile?: string;
  };
  runtime: {
    cwd: string;
    packageDir: string;
    model: { provider: string; id: string };
    thinking?: ThinkingLevel;
    tools: string[];
    noExtensions: boolean;
    extensionPaths: string[];
    noSkills: boolean;
    /** Replacement prompt for custom profiles; absent uses Pi's native system prompt. */
    systemPrompt?: string;
    /** Prompt composition policy for the child runtime. */
    promptPolicy?: "native" | "inherit";
  };
  run: {
    prompt: string;
    maxTurns?: number;
    graceTurns: number;
  };
  bridge: {
    mailboxDir: string;
  };
  /** Context ledger carried by this launch; the child persists its node on first run. */
  ledger?: { node: ContextLedgerNode };
}

/** Persistent Pi session identity of a child agent session. */
export interface AgentSessionIdentity {
  sessionId: string;
  /** JSONL session file, once the child reports ready. */
  sessionFile?: string;
  /** Display name shown in /resume and the session selector. */
  sessionName: string;
  /** Parent session file the child is nested under (may be absent for ephemeral parents). */
  parentSessionFile?: string;
}

/** tmux window hosting a child agent session. */
export interface AgentWindowInfo {
  /** Stable tmux window id (e.g. "@2") — never the mutable numeric index. */
  id: string;
  /** Numeric window index at creation time (display only). */
  index: number;
  name: string;
  state: "starting" | "alive" | "closed";
}

export interface AgentRecord {
  id: string;
  type: SubagentType;
  description: string;
  status: "queued" | "running" | "completed" | "steered" | "aborted" | "stopped" | "error";
  result?: string;
  error?: string;
  toolUses: number;
  startedAt: number;
  completedAt?: number;
  /** Set when result was already consumed via get_subagent_result — suppresses completion notification. */
  resultConsumed?: boolean;
  /** Batch grouping (smart join mode) — write-only bookkeeping. */
  joinMode?: JoinMode;
  /** Group id when the agent was part of a parallel batch. */
  groupId?: string;
  /** Steering messages queued before the child session was ready. */
  pendingSteers?: string[];
  /** Original task submitted when this child was created. */
  originalPrompt: string;
  /** Most recently approved task/follow-up. */
  effectivePrompt: string;
  /** Last meaningful lifecycle or activity update. */
  updatedAt: number;
  /** Human review timestamp. Terminal records without this need review. */
  reviewedAt?: number;
  /** Number of runs in this retained child session, including the initial run. */
  runNumber: number;
  /** Current run turn count. */
  turnCount: number;
  /** Effective current run turn limit. */
  maxTurns?: number;
  /** Latest meaningful tool activity for the compact overview. */
  latestActivity?: {
    toolName: string;
    action: string;
    target?: string;
    startedAt: number;
    completedAt?: number;
  };
  /** Human-readable terminal reason, separate from provider errors. */
  stopReason?: string;
  /** Acknowledgement state for steering or follow-up commands. */
  feedback?: {
    kind: "steer" | "follow-up";
    text: string;
    state: "queued" | "delivered" | "awaiting-run" | "failed";
    updatedAt: number;
    error?: string;
  };
  /** The tool_use_id from the original Agent tool call. */
  toolCallId?: string;
  /**
   * Lifetime usage breakdown, accumulated via run_settled usage reports.
   * Total = input + output + cacheWrite. Initialized to zeros at spawn.
   */
  lifetimeUsage: LifetimeUsage;
  /** Number of times this agent's session has compacted. */
  compactionCount: number;
  /**
   * Whether this agent was spawned to run in the background. Tri-state, set at
   * spawn from `SpawnOptions.isBackground`: `true` = background, `false` =
   * foreground (has an inline Agent tool-result surface), `undefined` = the
   * caller never declared it (e.g. a cross-extension RPC spawn, which is detached
   * and has no inline surface).
   */
  isBackground?: boolean;
  /** Resolved spawn params, captured for UI display. Fixed at spawn time. */
  invocation?: AgentInvocation;
  /** Persistent child Pi session identity (set once the child reports ready). */
  childSession?: AgentSessionIdentity;
  /** tmux window hosting the child (absent while concurrency-queued). */
  window?: AgentWindowInfo;
  /** Filesystem mailbox dir shared with the child process. */
  mailboxDir?: string;
  /** Path of the launch spec handed to the child (deleted by the child after reading). */
  launchSpecPath?: string;
  /** Retained launch spec — reused to reopen the session in a new window. */
  launchSpec?: AgentLaunchSpec;
}

export interface AgentInvocation {
  /** Short display name, e.g. "haiku" — only set when different from parent. */
  modelName?: string;
  thinking?: ThinkingLevel;
  maxTurns?: number;
  runInBackground?: boolean;
}

/** Details attached to custom notification messages for visual rendering. */
export interface NotificationDetails {
  id: string;
  description: string;
  status: string;
  toolUses: number;
  turnCount: number;
  maxTurns?: number;
  totalTokens: number;
  durationMs: number;
  sessionFile?: string;
  error?: string;
  resultPreview: string;
  /** Notification kind — steering notifications are not completions. */
  kind?: "completion" | "human-steer";
  /** Additional agents in a group notification. */
  others?: NotificationDetails[];
}

export interface EnvInfo {
  isGitRepo: boolean;
  branch: string;
  platform: string;
}
