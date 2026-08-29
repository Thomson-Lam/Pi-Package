import type { AgentConfig, JoinMode, ThinkingLevel } from "./types.js";

interface AgentInvocationParams {
  model?: string;
  thinking?: string;
  max_turns?: number;
  run_in_background?: boolean;
}

export function resolveAgentInvocationConfig(
  agentConfig: AgentConfig | undefined,
  params: AgentInvocationParams,
): {
  modelInput?: string;
  modelFromParams: boolean;
  thinking?: ThinkingLevel;
  maxTurns?: number;
  runInBackground: boolean;
} {
  return {
    modelInput: agentConfig?.model ?? params.model,
    modelFromParams: agentConfig?.model == null && params.model != null,
    thinking: (agentConfig?.thinking ?? params.thinking) as ThinkingLevel | undefined,
    maxTurns: agentConfig?.maxTurns ?? params.max_turns,
    runInBackground: agentConfig?.runInBackground ?? params.run_in_background ?? false,
  };
}

export function resolveJoinMode(defaultJoinMode: JoinMode, runInBackground: boolean): JoinMode | undefined {
  return runInBackground ? defaultJoinMode : undefined;
}
