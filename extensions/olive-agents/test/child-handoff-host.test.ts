/**
 * child-handoff-host.test.ts — Host-level wiring for the constrained-context
 * handoff: `child-host.mjs` must register the before_agent_start delivery in
 * the bridge (once, guarded by shouldInjectHandoff) and fail fast — emit an
 * error settlement + exit — instead of launching when an approved packet
 * carries nothing at child start.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Read the host source and assert structural wiring that unit tests can't see
// (the bridge is built per child process).
const hostSource = readFileSync(
  fileURLToPath(new URL("../src/child-host.mjs", import.meta.url)),
  "utf-8",
);

describe("child-host.mjs handoff delivery wiring", () => {
  it("calls wireHandoffBridge from the bridge factory", () => {
    expect(hostSource).toContain("wireHandoffBridge");
    expect(hostSource).toMatch(/wireHandoffBridge\(pi, spec\);/);
  });

  it("wires the bridge factory into the child resource loader", () => {
    expect(hostSource).toMatch(/extensionFactories: \[\{ name: "olive-agent-bridge", factory: bridgeFactory \}\]/);
  });
});

describe("child-host.mjs fail-fast on empty approved packet", () => {
  it("refuses to launch when the approved packet carries no content", () => {
    expect(hostSource).toContain("handoff packet is empty");
    expect(hostSource).toMatch(/handoff packet is empty[\s\S]{0,600}?status: "error"/);
    expect(hostSource).toMatch(/status: "error"[\s\S]{0,400}?process\.exit\(1\)/);
  });
});