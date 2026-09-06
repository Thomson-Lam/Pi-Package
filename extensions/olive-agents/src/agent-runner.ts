/**
 * agent-runner.ts — Launch-spec preparation for child agent Pi sessions.
 *
 * The parent prepares everything the child needs to boot a native Pi
 * InteractiveMode over a persistent agent session (see REVIEW-UX-SPEC.md):
 * system prompt, tool allowlist, additive extension path hints, model/thinking,
 * session identity and mailbox wiring. The child host (child-host.mjs) uses
 * Pi's normal resource discovery alongside those launch-specific values.
 */

import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type ExtensionAPI, getPackageDir } from "@earendil-works/pi-coding-agent";
import { getAgentConfig, getConfig } from "./agent-types.js";
import { type ContextLedgerNode, type ReopenDescriptor } from "./context-ledger.js";
import { detectEnv } from "./env.js";
import { buildAgentPrompt, type PromptExtras } from "./prompts.js";
import { agentSessionName } from "./names.js";
import type { AgentLaunchSpec, SubagentType, ThinkingLevel } from "./types.js";
import { writeJsonAtomic } from "./event-mailbox.js";

// Re-export for callers that historically imported the spec from agent-runner.
export type { AgentLaunchSpec } from "./types.js";

/**
 * Tool names registered by THIS extension. Single source of truth so the
 * registration sites (index.ts) and the child exclusion list below can't
 * drift apart.
 */
export const SUBAGENT_TOOL_NAMES = {
  AGENT: "Agent",
} as const;

/** Legacy default retained for settings compatibility; omitted maxTurns means unlimited. */
let defaultMaxTurns: number | undefined;

/** Normalize legacy configuration values. */
export function normalizeMaxTurns(n: number | undefined): number | undefined {
  if (n == null || n === 0) return undefined;
  return Math.max(1, n);
}

export function validateMaxTurns(n: unknown): asserts n is number {
  if (typeof n !== "number" || !Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    throw new Error("max_turns is required and must be a positive integer.");
  }
}

/** Get the default max turns value. undefined = unlimited. */
export function getDefaultMaxTurns(): number | undefined { return defaultMaxTurns; }
/** Set the default max turns value. undefined or 0 = unlimited, otherwise minimum 1. */
export function setDefaultMaxTurns(n: number | undefined): void { defaultMaxTurns = normalizeMaxTurns(n); }

/** Additional turns allowed after the soft limit steer message. */
let graceTurns = 5;

/** Get the grace turns value. */
export function getGraceTurns(): number { return graceTurns; }
/** Set the grace turns value (minimum 1). */
export function setGraceTurns(n: number): void { graceTurns = Math.max(1, n); }

// ---- Launch specification ----

export interface PrepareLaunchInput {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  type: SubagentType;
  prompt: string;
  description: string;
  options: {
    model: Model<any>;
    thinking?: ThinkingLevel;
    maxTurns?: number;
  };
  agentId: string;
  childSessionId: string;
  /** Prompt policy selected by the caller; omitted means inherited behavior. */
  promptPolicy?: "native" | "inherit";
  parentSessionFile?: string;
  sessionDir?: string;
  mailboxDir: string;
  /** Optional context ledger node accompanying this launch. */
  ledgerNode?: ContextLedgerNode;
  /** Attached-context markdown delivered to the child as a custom message. */
  contextMessage?: string;
}

export interface PrepareLaunchResult {
  spec: AgentLaunchSpec;
  warnings: string[];
}

/**
 * Prepare the full launch specification for a child agent session. Runs the
 * parent runtime, but produces data for the child host instead of a live
 * session. Collects diagnostics as warnings (returned, not thrown) so the
 * caller can surface them.
 */
export async function prepareAgentLaunch(input: PrepareLaunchInput): Promise<PrepareLaunchResult> {
  const { pi, ctx, type, prompt, options } = input;
  if (options.maxTurns !== undefined) validateMaxTurns(options.maxTurns);
  const maxTurns = options.maxTurns;
  const config = getConfig(type);
  const agentConfig = getAgentConfig(type);
  const warnings: string[] = [];

  // Children always run in the parent's working directory and follow the
  // parent's already-resolved project trust decision.
  const effectiveCwd = ctx.cwd;
  const projectTrusted = typeof ctx.isProjectTrusted === "function"
    ? ctx.isProjectTrusted()
    : true;

  const env = await detectEnv(pi, effectiveCwd);

  const extras: PromptExtras = {};

  // general-purpose is an alias for Pi's native system prompt. An omitted
  // type inherits the parent's extension runtime and its active prompt hooks.
  let systemPrompt: string | undefined;
  if (agentConfig?.isDefault && agentConfig.name === "general-purpose") {
    systemPrompt = undefined;
  } else if (agentConfig) {
    systemPrompt = buildAgentPrompt(agentConfig, effectiveCwd, env, extras);
  } else {
    // Unknown type fallback: build a generic prompt from the canonical config.
    const fallback = {
      name: type,
      displayName: config.displayName,
      description: config.description,
      builtinToolNames: config.builtinToolNames,
      extensions: config.extensions,
      systemPrompt: "",
      isDefault: false,
    };
    systemPrompt = buildAgentPrompt(fallback, effectiveCwd, env, extras);
  }

  // Preserve the parent's active tool selection. Extension source paths are
  // only additive hints; the child performs normal Pi extension discovery so
  // extensions without tools are not lost.
  const allowedTools = pi.getActiveTools();
  const finalExtensionPaths = [...new Set(
    pi.getAllTools()
      .map((tool) => tool.sourceInfo?.path)
      .filter((path): path is string => Boolean(path) && !path.startsWith("<")),
  )];
  const effectivePrompt = prompt;

  const config2 = getConfig(type);
  const spec: AgentLaunchSpec = {
    version: 3,
    agent: {
      id: input.agentId,
      type,
      displayName: config2.displayName,
      description: input.description,
    },
    session: {
      id: input.childSessionId,
      name: agentSessionName(input.description),
      parentFile: input.parentSessionFile,
      sessionDir: input.sessionDir,
    },
    runtime: {
      cwd: effectiveCwd,
      packageDir: getPackageDir(),
      projectTrusted,
      model: { provider: options.model.provider, id: options.model.id },
      thinking: options.thinking,
      tools: allowedTools,
      extensionPaths: finalExtensionPaths,
      ...(systemPrompt === undefined ? {} : { systemPrompt }),
      ...(input.promptPolicy ? { promptPolicy: input.promptPolicy } : {}),
    },
    run: {
      prompt: effectivePrompt,
      maxTurns,
    },
    bridge: { mailboxDir: input.mailboxDir },
    ...(input.ledgerNode
      ? { ledger: { node: input.ledgerNode, ...(input.contextMessage ? { message: input.contextMessage } : {}) } }
      : {}),
  };

  if (!input.parentSessionFile) {
    warnings.push(
      "Parent session is ephemeral (--no-session); the agent session cannot be nested under it and will appear as a root session in /resume",
    );
  }

  return { spec, warnings };
}

/** Write a launch spec atomically. The child deletes it after reading. */
export function writeLaunchSpec(path: string, spec: AgentLaunchSpec): void {
  writeJsonAtomic(path, spec);
}

/**
 * Sanitized reopen descriptor derived from a launch spec, persisted in the
 * parent-session link so /ot can reopen the child session in a fresh window
 * after the original process has exited. Excludes mailbox paths, credentials,
 * and the original run prompt.
 */
export function buildReopenDescriptor(spec: AgentLaunchSpec): ReopenDescriptor {
  return {
    type: spec.agent.type,
    description: spec.agent.description,
    cwd: spec.runtime.cwd,
    projectTrusted: spec.runtime.projectTrusted,
    model: spec.runtime.model,
    thinking: spec.runtime.thinking,
    tools: spec.runtime.tools,
    extensionPaths: spec.runtime.extensionPaths,
    systemPrompt: spec.runtime.systemPrompt,
    promptPolicy: spec.runtime.promptPolicy,
    sessionDir: spec.session.sessionDir,
    maxTurns: spec.run.maxTurns,
  };
}
