/**
 * context-ledger.test.ts — Unit coverage for the durable context ledger:
 * message/tool extraction, snapshotting, prompt serialization, ancestor chain
 * resolution across session files, and /ot tree placement (nested, parallel,
 * skipped-parent, isolated). No LLM calls and no workspace writes — fixtures
 * live in tmp dirs and are built with the real SessionManager.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  CONTEXT_LEDGER_ENTRY,
  CONTEXT_LINK_ENTRY,
  type ContextLedgerNode,
  type ContextLinkData,
  buildContextPrompt,
  computeTreeRows,
  getSessionLedgerNode,
  getSessionLinks,
  loadLedgerGraph,
  nodeToMarkdown,
  resolveLedgerChain,
  resolveNearestLedgerAncestors,
  selectableMessages,
  sessionDisplayName,
  snapshotSelections,
} from "../src/context-ledger.js";

let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "olive-context-ledger-"));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

type SM = SessionManager;

function makeSession(id: string, parentFile?: string): SM {
  const sm = SessionManager.create(work, work, parentFile ? { id, parentSession: parentFile } : { id });
  // Session name + a message so the file is persisted on disk.
  sm.appendSessionInfo(`session-${id}`);
  return sm;
}

function withLedger(sm: SM, node: ContextLedgerNode, children: ContextLinkData[] = [], childSessions: Map<string, SM> = new Map()): void {
  sm.appendCustomEntry(CONTEXT_LEDGER_ENTRY, { version: 1, node });
  for (const child of children) {
    sm.appendCustomEntry(CONTEXT_LINK_ENTRY, { ...child, stage: "ready", createdAt: child.createdAt ?? new Date().toISOString() });
  }
  // Persist: the file is only written once an assistant message exists.
  sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "ok" }], provider: "test", model: "basic", stopReason: "stop" } as never);
}

function link(sm: SM, child: SM, node: ContextLedgerNode | undefined, opts: Partial<ContextLinkData> = {}): ContextLinkData {
  return {
    version: 1,
    stage: "ready",
    agentId: `agent-${child ? (child.getSessionId() ?? "x").slice(0, 8) : "x"}`,
    agentType: "general-purpose",
    description: "child",
    childSessionId: child.getSessionId()!,
    childSessionName: `agent-${child.getSessionId()}`,
    childSessionFile: child.getSessionFile()!,
    ledgerNodeId: node?.id,
    parentLedgerId: node?.parentId,
    createdAt: new Date().toISOString(),
    reopen: {
      type: "general-purpose", description: "child", cwd: work,
      model: { provider: "test", id: "basic" }, tools: [], noExtensions: true,
      extensionPaths: [], noSkills: false,
    },
    ...opts,
  };
}

function node(id: string, parentId: string | undefined, createdAt = "2025-01-01T00:00:00.000Z"): ContextLedgerNode {
  return {
    version: 1, id, parentId, sourceSessionName: "src", createdAt,
    selections: [{ kind: "message", entryId: "m1", role: "user", label: "user · hello", text: "hello world" }],
  };
}

describe("message extraction", () => {
  it("selectableMessages excludes tool-only assistant and toolResult entries", () => {
    const sm = makeSession("root");
    const e1 = sm.appendMessage({ role: "user", content: "hello" });
    const e2 = sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "hi" }] } as never);
    const e3 = sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "" }, { type: "tool_use", id: "tu1", name: "bash", input: { command: "npm test" } }],
    } as never);
    const e4 = sm.appendMessage({ role: "toolResult", toolCallId: "tu1", toolName: "bash", content: [{ type: "text", text: "43 passed" }] } as never);
    sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "ok" }], provider: "test", model: "basic", stopReason: "stop" } as never);

    const rows = selectableMessages(sm.getBranch());
    const ids = rows.map((r) => r.entryId);
    expect(ids).toContain(e1);
    expect(ids).toContain(e2);
    expect(ids).not.toContain(e3);
    expect(ids).not.toContain(e4);
  });

  it("tool results are excluded from selectable rows (deemed noise for the ledger)", () => {
    const sm = makeSession("root");
    sm.appendMessage({ role: "user", content: "run tests" });
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "tool_use", id: "tu1", name: "bash", input: { command: "npm test" } }],
    } as never);
    sm.appendMessage({ role: "toolResult", toolCallId: "tu1", toolName: "bash", content: [{ type: "text", text: "43 passed" }] } as never);
    sm.appendMessage({ role: "bashExecution", command: "!ls", output: "src\\ntest\\n", exitCode: 0, timestamp: Date.now() } as never);
    sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "ok" }], provider: "test", model: "basic", stopReason: "stop" } as never);

    const rows = selectableMessages(sm.getBranch());
    expect(rows.length).toBe(2); // user + assistant text only
    expect(rows.some((r) => r.preview.includes("43 passed"))).toBe(false);
  });
});

describe("snapshotting", () => {
  it("snapshotSelections snapshots messages only; tool entries are skipped", () => {
    const sm = makeSession("root");
    const e1 = sm.appendMessage({ role: "user", content: "the objective" });
    const e2 = sm.appendMessage({
      role: "assistant",
      content: [{ type: "tool_use", id: "tu1", name: "read", input: { path: "src/a.ts" } }],
    } as never);
    const e3 = sm.appendMessage({ role: "toolResult", toolCallId: "tu1", toolName: "read", content: [{ type: "text", text: "file body" }] } as never);
    sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "ok" }], provider: "test", model: "basic", stopReason: "stop" } as never);

    // Selecting message + tool entries still snapshots only the message.
    const snapshots = snapshotSelections(sm.getBranch(), new Set([e1, e2, e3]));
    expect(snapshots.length).toBe(1);
    expect(snapshots[0]).toMatchObject({ kind: "message", role: "user", text: "the objective" });
  });
});

describe("serialization", () => {
  it("nodeToMarkdown renders summary + selections", () => {
    const n = node("L1", undefined);
    n.summary = "compacted decisions";
    const md = nodeToMarkdown(n);
    expect(md).toContain("Compacted context");
    expect(md).toContain("compacted decisions");
    expect(md).toContain("Selected messages");
    expect(md).toContain("hello world");
  });

  it("buildContextPrompt embeds inherited chain then the new node", () => {
    const parent = node("L1", undefined);
    const child = node("L2", "L1");
    const prompt = buildContextPrompt("do the thing", [parent], child);
    expect(prompt).toMatch(/^# context/);
    expect(prompt).toContain("Inherited context 1");
    expect(prompt).toContain("## Context: src");
    expect(prompt).toContain("# instructions");
    expect(prompt).toContain("do the thing");
  });
});

describe("ancestor chain resolution", () => {
  it("walks session-header parent links upward (root→leaf)", () => {
    const root = makeSession("root");
    root.appendMessage({ role: "assistant", content: [{ type: "text", text: "ok" }], provider: "test", model: "basic", stopReason: "stop" } as never);
    const rootFile = root.getSessionFile()!;
    const parent = makeSession("parent", rootFile);
    withLedger(parent, node("L1", undefined), [], new Map());
    const parentFile = parent.getSessionFile()!;
    const leaf = makeSession("leaf", parentFile);
    withLedger(leaf, node("L2", "L1"), [], new Map());
    const leafFile = leaf.getSessionFile()!;

    expect(resolveLedgerChain(leafFile).map((n) => n.id)).toEqual(["L1", "L2"]);
    expect(resolveNearestLedgerAncestors(leafFile).map((n) => n.id)).toEqual(["L2", "L1"]);
    expect(resolveLedgerChain(rootFile)).toEqual([]);
  });

  it("sessionDisplayName reads session_info entries", () => {
    const sm = makeSession("named");
    sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "ok" }], provider: "test", model: "basic", stopReason: "stop" } as never);
    expect(sessionDisplayName(sm.getSessionFile()!)).toContain("session-named");
  });
});

describe("ledger graph + tree placement", () => {
  it("nested chain renders [0] root / [1a] child / [2] grandchild", () => {
    const root = makeSession("root");
    const child = makeSession("child", root.getSessionFile()!);
    withLedger(child, node("L1", undefined));
    const grand = makeSession("grand", child.getSessionFile()!);
    withLedger(grand, node("L2", "L1"));
    const cLink = link(root, child, node("L1", undefined));
    root.appendCustomEntry(CONTEXT_LINK_ENTRY, { ...cLink, stage: "ready" });
    const gLink = link(child, grand, node("L2", "L1"));
    child.appendCustomEntry(CONTEXT_LINK_ENTRY, { ...gLink, stage: "ready" });
    root.appendMessage({ role: "assistant", content: [{ type: "text", text: "ok" }], provider: "test", model: "basic", stopReason: "stop" } as never);

    const graph = loadLedgerGraph(root.getSessionFile()!);
    const rows = computeTreeRows(graph, root.getSessionFile()!);
    expect(rows.map((r) => r.number)).toEqual(["[0]", "[1a]", "[2]"]);
    expect(rows[1]!.node!.id).toBe("L1");
    expect(rows[2]!.node!.id).toBe("L2");
  });

  it("parallel children render [1a] and [1b] under the root", () => {
    const root = makeSession("root");
    const a = makeSession("a", root.getSessionFile()!);
    withLedger(a, node("L1a", undefined, "2025-01-01T00:00:00.000Z"));
    const b = makeSession("b", root.getSessionFile()!);
    withLedger(b, node("L1b", undefined, "2025-01-02T00:00:00.000Z"));
    root.appendCustomEntry(CONTEXT_LINK_ENTRY, { ...link(root, a, node("L1a", undefined)), stage: "ready" });
    root.appendCustomEntry(CONTEXT_LINK_ENTRY, { ...link(root, b, node("L1b", undefined)), stage: "ready" });
    root.appendMessage({ role: "assistant", content: [{ type: "text", text: "ok" }], provider: "test", model: "basic", stopReason: "stop" } as never);

    const graph = loadLedgerGraph(root.getSessionFile()!);
    const rows = computeTreeRows(graph, root.getSessionFile()!);
    expect(rows.map((r) => r.number)).toEqual(["[0]", "[1a]", "[1b]"]);
  });

  it("skipped-parent: a child inherited from the root's ledger sits level with its sibling", () => {
    const root = makeSession("root");
    withLedger(root, node("L0", undefined));
    const b2 = makeSession("b2", root.getSessionFile()!);
    withLedger(b2, node("L_a", "L0"));
    const b3 = makeSession("b3", b2.getSessionFile()!);
    withLedger(b3, node("L_b", "L0")); // launched by b2 but extends root's ledger
    root.appendCustomEntry(CONTEXT_LINK_ENTRY, { ...link(root, b2, node("L_a", "L0")), stage: "ready" });
    b2.appendCustomEntry(CONTEXT_LINK_ENTRY, { ...link(b2, b3, node("L_b", "L0")), stage: "ready" });
    root.appendMessage({ role: "assistant", content: [{ type: "text", text: "ok" }], provider: "test", model: "basic", stopReason: "stop" } as never);

    const graph = loadLedgerGraph(root.getSessionFile()!);
    const rows = computeTreeRows(graph, root.getSessionFile()!);
    // Both b2 and b3 attach under the root (holder of L0) as parallel rows.
    expect(rows.map((r) => r.number)).toEqual(["[0]", "[1a]", "[1b]"]);
    expect(rows[1]!.node!.id).toBe("L_a");
    expect(rows[2]!.node!.id).toBe("L_b");
  });

  it("isolated children render under their launching session", () => {
    const root = makeSession("root");
    const iso = makeSession("iso", root.getSessionFile()!);
    root.appendCustomEntry(CONTEXT_LINK_ENTRY, { ...link(root, iso, undefined), stage: "ready" });
    root.appendMessage({ role: "assistant", content: [{ type: "text", text: "ok" }], provider: "test", model: "basic", stopReason: "stop" } as never);

    const graph = loadLedgerGraph(root.getSessionFile()!);
    const rows = computeTreeRows(graph, root.getSessionFile()!);
    expect(rows.map((r) => r.number)).toEqual(["[0]", "[isolated]"]);
    expect(rows[1]!.kind).toBe("isolated");
  });

  it("getSessionLedgerNode/getSessionLinks round-trip via persisted entries", () => {
    const sm = makeSession("root");
    const n = node("L9", undefined);
    withLedger(sm, n, [link(sm, sm, undefined)], new Map());
    const entries = sm.getBranch();
    const read = plainEntriesFor(sm);
    expect(getSessionLedgerNode(entries)?.id).toBe("L9");
    expect(getSessionLinks(entries).length).toBe(1);
    expect(read.some((e) => e.type === "custom" && e.customType === CONTEXT_LEDGER_ENTRY)).toBe(true);
  });
});

function plainEntriesFor(sm: SM) {
  return sm.getBranch();
}
describe("ancestor loading for /ot view re-rooting", () => {
  it("loadLedgerGraph includes ancestors so h can re-root the view", () => {
    const root = makeSession("root");
    const child = makeSession("child", root.getSessionFile()!);
    withLedger(child, node("L1", undefined));
    root.appendCustomEntry(CONTEXT_LINK_ENTRY, { ...link(root, child, node("L1", undefined)), stage: "ready" });
    root.appendMessage({ role: "assistant", content: [{ type: "text", text: "ok" }], provider: "test", model: "basic", stopReason: "stop" } as never);

    // /ot invoked inside the child: the graph must contain the ancestor.
    const graph = loadLedgerGraph(child.getSessionFile()!);
    expect(graph.sessions.has(root.getSessionFile()!)).toBe(true);

    // Re-rooted at the ancestor, the child renders beneath it.
    const rows = computeTreeRows(graph, root.getSessionFile()!);
    expect(rows.map((r) => r.number)).toEqual(["[0]", "[1a]"]);
    expect(rows[1]!.node!.id).toBe("L1");
  });

  it("cycle guard: ancestors never render as children (no A↔main loop)", () => {
    // Real-world shape: main + a verify agent + the current agent A, where A
    // is viewed from its own session (graph contains main as ancestor).
    const main = makeSession("main");
    const a = makeSession("a", main.getSessionFile()!);
    withLedger(a, node("LA", undefined));
    const verify = makeSession("verify", main.getSessionFile()!);
    withLedger(verify, node("LV", undefined));
    const orphan = makeSession("orphan", main.getSessionFile()!); // no ledger → isolated
    for (const [child, n] of [[a, node("LA", undefined)], [verify, node("LV", undefined)], [orphan, undefined]] as const) {
      main.appendCustomEntry(CONTEXT_LINK_ENTRY, { ...link(main, child!, n), stage: "ready" });
    }
    main.appendMessage({ role: "assistant", content: [{ type: "text", text: "ok" }], provider: "test", model: "basic", stopReason: "stop" } as never);

    const graph = loadLedgerGraph(a.getSessionFile()!); // invoked inside A
    // main is in the graph (ancestor), but A's view must show ONLY A.
    expect(graph.sessions.has(main.getSessionFile()!)).toBe(true);
    const rows = computeTreeRows(graph, a.getSessionFile()!);
    expect(rows.map((r) => r.number)).toEqual(["[0]"]);
    expect(rows[0]!.sessionFile).toBe(a.getSessionFile()!);

    // Re-rooted at main (h): A, the verify agent, and the isolated orphan
    // each render exactly once — no repeated nesting.
    const mainRows = computeTreeRows(graph, main.getSessionFile()!);
    const numbers = mainRows.map((r) => r.number);
    expect(numbers).toEqual(["[0]", "[1a]", "[1b]", "[isolated]"]);
  });
});
