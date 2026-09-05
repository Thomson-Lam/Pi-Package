import type { AgentConfig, ThinkingLevel } from "./types.js";

interface AgentInvocationParams {
  model?: string;
  thinking?: string;
  max_turns?: number;
}

/** Resolve the launch settings that are still meaningful for Agent calls.
 * Legacy background-mode input is intentionally ignored. */
export function resolveAgentInvocationConfig(
  agentConfig: AgentConfig | undefined,
  params: AgentInvocationParams,
): {
  modelInput?: string;
  modelFromParams: boolean;
  thinking?: ThinkingLevel;
  maxTurns?: number;
} {
  return {
    modelInput: agentConfig?.model ?? params.model,
    modelFromParams: agentConfig?.model == null && params.model != null,
    thinking: (agentConfig?.thinking ?? params.thinking) as ThinkingLevel | undefined,
    // The parent tool call owns the work-turn budget. Agent frontmatter is
    // retained for manual/non-tool callers, but cannot override this value.
    maxTurns: params.max_turns,
  };
}
