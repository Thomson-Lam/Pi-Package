/**
 * default-agents.ts — Embedded default agent configurations.
 *
 * These are always available but can be overridden by user .md files with the same name.
 */

import type { AgentConfig } from "./types.js";

const READ_ONLY_TOOLS = ["read", "bash", "grep", "find", "ls"];

export const DEFAULT_AGENTS: Map<string, AgentConfig> = new Map([
  [
    "general-purpose",
    {
      name: "general-purpose",
      displayName: "Agent",
      description: "General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks. When you are searching for a keyword or file and are not confident that you will find the right match in the first few tries use this agent to perform the search for you.",
      // builtinToolNames omitted — means "all available tools" (resolved at lookup time)
      // inheritContext / runInBackground / isolated omitted — strategy fields, callers decide per-call.
      // Setting them to false would lock callsite intent (see resolveAgentInvocationConfig in invocation-config.ts).
      extensions: true,
      skills: true,
      systemPrompt: "",
      promptMode: "append",
      isDefault: true,
    },
  ],
  [
    "Review",
    {
      name: "Review",
      displayName: "Review",
      description: "Read-only code review agent for finding concrete bugs, regressions, security risks, and missing tests in proposed changes. Reports actionable findings with file and line references and does not modify files.",
      builtinToolNames: READ_ONLY_TOOLS,
      extensions: true,
      skills: true,
      model: "opencode-go/deepseek-v4-flash",
      thinking: "high",
      systemPrompt: `# CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS
You are a senior code reviewer. Review the requested changes or code for concrete defects.
You do NOT have access to file editing tools and must not modify the repository.

You are STRICTLY PROHIBITED from:
- Creating, modifying, deleting, moving, or copying files
- Running commands that change repository or system state
- Using shell redirects or heredocs to write files

Focus on:
- Correctness bugs and regressions
- Security, privacy, and data-loss risks
- Broken edge cases and error handling
- Violations of established project behavior
- Missing tests when they expose a concrete risk

Review process:
1. Inspect the relevant diff, files, tests, and nearby call sites.
2. Verify each potential finding against the actual code.
3. Prioritize findings by severity; omit style-only preferences and speculation.
4. If no concrete problems are found, say so explicitly.

# Tool Usage
- Use the find tool for file pattern matching
- Use the grep tool for content search
- Use the read tool for reading files
- Use Bash only for read-only operations such as git diff, git status, and git log

# Output
- Put findings first, ordered by severity
- Include an absolute file path and line number for every finding
- Explain impact and the smallest reasonable correction
- Keep summaries brief
- Do not use emojis`,
      promptMode: "replace",
      isDefault: true,
    },
  ],
]);
