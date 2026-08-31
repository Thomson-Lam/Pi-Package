import { describe, expect, it } from "vitest";
import { resolveAgentInvocationConfig, resolveJoinMode } from "../src/invocation-config.js";
import type { AgentConfig } from "../src/types.js";

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "Explore", description: "Explore", extensions: false, skills: false,
    systemPrompt: "Test agent", ...overrides,
  };
}

describe("resolveAgentInvocationConfig", () => {
  it("prefers configured model and thinking, but parent turn limit", () => {
    const resolved = resolveAgentInvocationConfig(makeConfig({
      model: "provider/config-model", thinking: "high", maxTurns: 42,
    }), { model: "provider/param-model", thinking: "minimal", max_turns: 1 });
    expect(resolved.modelInput).toBe("provider/config-model");
    expect(resolved.modelFromParams).toBe(false);
    expect(resolved.thinking).toBe("high");
    expect(resolved.maxTurns).toBe(1);
  });

  it("uses tool-call values when no agent config is available", () => {
    const resolved = resolveAgentInvocationConfig(undefined, {
      model: "provider/param-model", thinking: "minimal", max_turns: 3, run_in_background: true,
    });
    expect(resolved.modelInput).toBe("provider/param-model");
    expect(resolved.modelFromParams).toBe(true);
    expect(resolved.thinking).toBe("minimal");
    expect(resolved.maxTurns).toBe(3);
    expect(resolved.runInBackground).toBe(true);
  });

  it("defaults parent behavior to detach", () => {
    expect(resolveAgentInvocationConfig(makeConfig(), {}).runInBackground).toBe(false);
  });
});

describe("resolveJoinMode", () => {
  it("returns the global default for background agents", () => {
    expect(resolveJoinMode("smart", true)).toBe("smart");
    expect(resolveJoinMode("async", true)).toBe("async");
  });

  it("ignores join mode for detached agents", () => {
    expect(resolveJoinMode("smart", false)).toBeUndefined();
    expect(resolveJoinMode("group", false)).toBeUndefined();
  });
});
