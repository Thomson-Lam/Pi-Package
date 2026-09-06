import { describe, expect, it } from "vitest";
import { agentSessionName, agentWindowName, parentWindowName } from "../src/names.js";

describe("agentWindowName", () => {
  it("uses the task description", () => {
    expect(agentWindowName("Inspect auth flow")).toBe("Inspect-auth-flow");
  });
  it("sanitizes punctuation, whitespace, and bounds length", () => {
    expect(agentWindowName("  inspect / auth\nflow!!!  ")).toBe("inspect-auth-flow");
    expect(agentWindowName("x".repeat(100)).length).toBeLessThanOrEqual(48);
    expect(agentWindowName("")).toBe("agent");
  });
});

describe("parentWindowName", () => {
  it("prefixes the child description with [P]", () => {
    expect(parentWindowName("21:20-[S]: inspect auth")).toBe("[P] inspect-auth");
  });
  it("truncates the complete label without leaving a trailing delimiter", () => {
    expect(parentWindowName("x".repeat(100))).toMatch(/^\[P\] x+$/);
    expect(parentWindowName("[P] inspect-auth")).toBe("[P] inspect-auth");
  });
});

describe("agentSessionName", () => {
  it("uses '<HH:MM>-[S]: <description>'", () => {
    expect(agentSessionName("inspect approval flickering"))
      .toMatch(/^\d{2}:\d{2}-\[S\]: inspect approval flickering$/);
  });
});
