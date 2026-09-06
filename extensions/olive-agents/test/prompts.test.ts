import { describe, expect, it } from "vitest";
import { buildAgentPrompt } from "../src/prompts.js";
import type { AgentConfig } from "../src/types.js";

const config: AgentConfig = {
  name: "review", description: "Review", extensions: true,
  systemPrompt: "Review carefully.",
};
const env = { isGitRepo: true, branch: "main", platform: "linux" };

describe("buildAgentPrompt", () => {
  it("uses only the replacement prompt and child environment", () => {
    const result = buildAgentPrompt(config, "/workspace", env);
    expect(result).toContain("Review carefully.");
    expect(result).toContain("Working directory: /workspace");
    expect(result).not.toContain("parent system");
    expect(result).not.toContain("sub_agent_context");
  });

  it("adds the configured memory block", () => {
    const result = buildAgentPrompt(config, "/workspace", env, { memoryBlock: "# Memory" });
    expect(result).toContain("# Memory");
  });
});
