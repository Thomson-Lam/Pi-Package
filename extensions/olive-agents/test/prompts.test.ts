import { describe, expect, it } from "vitest";
import { buildAgentPrompt } from "../src/prompts.js";
import type { AgentConfig } from "../src/types.js";

const config: AgentConfig = {
  name: "review", description: "Review", extensions: true, skills: false,
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

  it("adds configured skill and memory blocks", () => {
    const result = buildAgentPrompt(config, "/workspace", env, {
      memoryBlock: "# Memory",
      skillBlocks: [{ name: "api", content: "Use REST." }],
    });
    expect(result).toContain("# Memory");
    expect(result).toContain("Preloaded Skill: api");
  });
});
