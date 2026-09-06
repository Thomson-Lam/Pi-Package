import { describe, expect, it } from "vitest";
import { resolveAgentInvocationConfig } from "../src/invocation-config.js";
import type { AgentConfig } from "../src/types.js";

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return { name: "Explore", description: "Explore", extensions: false, systemPrompt: "Test agent", ...overrides };
}

describe("resolveAgentInvocationConfig", () => {
  it("prefers configured model and thinking, but parent turn limit", () => {
    const resolved = resolveAgentInvocationConfig(makeConfig({ model: "provider/config-model", thinking: "high", maxTurns: 42 }), {
      model: "provider/param-model", thinking: "minimal", max_turns: 1,
    });
    expect(resolved).toMatchObject({ modelInput: "provider/config-model", modelFromParams: false, thinking: "high", maxTurns: 1 });
  });

  it("uses tool-call values and silently ignores legacy background input", () => {
    const resolved = resolveAgentInvocationConfig(undefined, {
      model: "provider/param-model", thinking: "minimal", max_turns: 3,
      run_in_background: true,
    } as any);
    expect(resolved).toEqual({ modelInput: "provider/param-model", modelFromParams: true, thinking: "minimal", maxTurns: 3 });
  });

  it("does not expose a parent behavior setting", () => {
    expect(resolveAgentInvocationConfig(makeConfig(), {})).not.toHaveProperty("runInBackground");
  });
});
