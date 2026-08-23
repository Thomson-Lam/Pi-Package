/**
 * context-review.test.ts — Stable TUI conventions for the context packet
 * review: the item list keeps a constant rendered height (no resize/flicker as
 * items are removed) and every line stays within the terminal width; selection
 * can be restored to a previously viewed item by id.
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { ContextReviewList } from "../src/ui/context-review.js";
import type { PreparedContextHandoff } from "../src/handoff/types.js";

const themeStub = { bold: (text: string) => text, fg: (_color: string, text: string) => text };

function packet(snippetCount: number, overrides: Partial<PreparedContextHandoff> = {}): PreparedContextHandoff {
  const snippets = Array.from({ length: snippetCount }, (_, i) => ({
    id: `s${i + 1}`,
    path: `f${i + 1}.ts`,
    absolutePath: `/tmp/x/f${i + 1}.ts`,
    startLine: 1,
    endLine: 1,
    content: `line${i + 1}`,
    bytes: 6,
    estimatedTokens: 2,
    sourceHash: "h".repeat(64),
  }));
  return {
    version: 1,
    snippets,
    recommendedFiles: [],
    snippetProblems: [],
    leadProblems: [],
    packetProblems: [],
    warnings: [],
    totalBytes: snippetCount * 6,
    estimatedTokens: snippetCount * 2,
    ...overrides,
  };
}

function noopActions() {
  return { view: () => {}, remove: () => {}, back: () => {} };
}

describe("ContextReviewList — fixed height", () => {
  it("renders the same line count for 0, 1, 5, 12, and 50 items", () => {
    const counts = [0, 1, 5, 12, 50];
    const heights = counts.map((count) => new ContextReviewList(packet(count), noopActions(), themeStub).render(100).length);
    expect(new Set(heights).size).toBe(1);
  });

  it("keeps the same height when warnings / packet problems / items change", () => {
    const plain = new ContextReviewList(packet(3), noopActions(), themeStub).render(100);
    const noisy = new ContextReviewList(
      packet(3, {
        warnings: ["dup", "dup2", "dup3"],
        packetProblems: [{ id: "packet-too-large", kind: "too-large", message: "Packet is far too large." }],
      }),
      noopActions(),
      themeStub,
    ).render(100);
    expect(noisy.length).toBe(plain.length);
  });

  it("never exceeds the terminal width on any rendered line", () => {
    const list = new ContextReviewList(packet(50), noopActions(), themeStub);
    for (const width of [40, 80, 120]) {
      for (const line of list.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  it("clamps the selection when the packet shrinks", () => {
    const list = new ContextReviewList(packet(50), noopActions(), themeStub);
    list.handleInput("j");
    list.handleInput("j");
    list.handleInput("j");
    list.handleInput("j");
    expect(list.getSelectedIndex()).toBe(4);
  });
});

describe("ContextReviewList — selection restoration", () => {
  it("restores a previously viewed item by id when re-entering the list", () => {
    const list = new ContextReviewList(packet(20), noopActions(), themeStub, "s7");
    expect(list.getSelectedIndex()).toBe(6);
    // The selected row is the restored item.
    const lines = list.render(100);
    expect(lines.some((line) => line.includes("→") && line.includes("f7.ts"))).toBe(true);
  });

  it("falls back to index 0 when the preferred id is absent", () => {
    const list = new ContextReviewList(packet(5), noopActions(), themeStub, "does-not-exist");
    expect(list.getSelectedIndex()).toBe(0);
  });
});