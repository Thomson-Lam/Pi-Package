/**
 * prompts.ts — System prompt builder for agents.
 */

import type { AgentConfig, EnvInfo } from "./types.js";

/** Extra sections to inject into the agent system prompt. */
export interface PromptExtras {
  memoryBlock?: string;
}

/**
 * Build the child system prompt. The child always uses its own replacement
 * prompt; the parent's conversation and system prompt are never copied.
 */
export function buildAgentPrompt(
  config: AgentConfig,
  cwd: string,
  env: EnvInfo,
  extras?: PromptExtras,
): string {
  const activeAgentTag = `<active_agent name="${config.name}"/>\n\n`;
  const envBlock = `# Environment
Working directory: ${cwd}
${env.isGitRepo ? `Git repository: yes\nBranch: ${env.branch}` : "Not a git repository"}
Platform: ${env.platform}`;

  const extraSections: string[] = [];
  if (extras?.memoryBlock) extraSections.push(extras.memoryBlock);
  const extrasSuffix = extraSections.length > 0 ? "\n\n" + extraSections.join("\n") : "";

  const header = `You are a pi coding agent sub-agent.
You have been invoked to handle a specific task under human supervision.

${envBlock}`;
  const instructions = config.systemPrompt?.trim()
    ? `\n\n<agent_instructions>\n${config.systemPrompt}\n</agent_instructions>`
    : "";
  return activeAgentTag + header + instructions + extrasSuffix;
}
