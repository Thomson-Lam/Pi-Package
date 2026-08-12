/**
 * names.test.ts — Zellij-style generated names for agent windows, fleet rows,
 * and /resume sessions.
 */

import { describe, expect, it } from "vitest";
import {
  agentSessionName,
  agentTypeSlug,
  agentWindowName,
  hashString,
  localTimeStamp,
  zellijName,
  ZELLIJ_ADJECTIVES,
  ZELLIJ_NOUNS,
} from "../src/names.js";

describe("zellijName", () => {
  it("produces adjective-noun codenames from Zellij's word lists", () => {
    for (const seed of ["a", "abc123", "review-42", "general-purpose"]) {
      const [adj, noun] = zellijName(seed).split("-");
      expect(ZELLIJ_ADJECTIVES).toContain(adj);
      expect(ZELLIJ_NOUNS).toContain(noun);
    }
  });

  it("is deterministic across calls", () => {
    expect(zellijName("a1b2c3d4")).toBe(zellijName("a1b2c3d4"));
  });

  it("differs for different seeds", () => {
    expect(zellijName("a1b2c3d4")).not.toBe(zellijName("e5f6g7h8"));
  });

  it("hashString is stable", () => {
    expect(hashString("a1b2c3d4")).toBe(hashString("a1b2c3d4"));
  });
});

describe("agentTypeSlug", () => {
  it("maps the built-ins", () => {
    expect(agentTypeSlug("general-purpose")).toBe("general");
    expect(agentTypeSlug("Review")).toBe("review");
  });
  it("slugifies custom types", () => {
    expect(agentTypeSlug("Security Auditor")).toBe("security-auditor");
  });
});

describe("agentWindowName", () => {
  it("combines codename and type slug", () => {
    expect(agentWindowName("a1b2c3d4", "general-purpose")).toMatch(/^[a-z]+-[a-z]+-general$/);
    expect(agentWindowName("a1b2c3d4", "Review")).toMatch(/^[a-z]+-[a-z]+-review$/);
  });
  it("is deterministic and length-bounded", () => {
    expect(agentWindowName("a1b2c3d4", "Review")).toBe(agentWindowName("a1b2c3d4", "Review"));
    expect(agentWindowName("a1b2c3d4", "x".repeat(100)).length).toBeLessThanOrEqual(48);
  });
});

describe("agentSessionName", () => {
  it("uses '<HH:MM> <codename>-<type>'", () => {
    const name = agentSessionName("a1b2c3d4", "general-purpose");
    expect(name).toMatch(/^\d{2}:\d{2} [a-z]+-[a-z]+-general$/);
    expect(name).not.toContain("(using Node)");
  });
  it("stays deterministic within the same minute", () => {
    expect(agentSessionName("a1b2c3d4", "Review")).toBe(agentSessionName("a1b2c3d4", "Review"));
  });
});

describe("localTimeStamp", () => {
  it("is HH:MM", () => {
    expect(localTimeStamp()).toMatch(/^\d{2}:\d{2}$/);
  });
});
