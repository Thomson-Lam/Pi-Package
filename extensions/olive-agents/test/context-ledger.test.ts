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
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  CONTEXT_LEDGER_ENTRY,
  CONTEXT_LINK_ENTRY,
  type ContextLedgerNode,
  type ContextLinkData,
  type TreeRow,
  buildContextPrompt,
  computeTreeRows,
  finalizeLedgerContext,
  getSessionLedgerNode,
  getSessionLinks,
  loadLedgerGraph,
  nodeToMarkdown,
  readSessionEntries,
  resolveLedgerChain,
  resolveNearestLedgerAncestors,
  selectableMessages,
  sessionDisplayName,
  snapshotSelections,
} from "../src/context-ledger.js";
import { buildContextUI } from "../src/ui/context-selection.js";
import { openContextTree, type ContextTreeInput } from "../src/ui/context-tree.js";

let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "olive-context-ledger-"));
  // The TUI components size themselves from process.stdout.rows; pin it so
  // captured renders are deterministic in any environment.
  Object.defineProperty(process.stdout, "rows", { value: 24, configurable: true });
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
  Object.defineProperty(process.stdout, "rows", { value: undefined, configurable: true });
});

type SM = SessionManager;

function makeSession(id: string, parentFile?: string, sessionName?: string): SM {
  const sm = SessionManager.create(work, work, parentFile ? { id, parentSession: parentFile } : { id });
  // Session name + a message so the file is persisted on disk.
  sm.appendSessionInfo(sessionName ?? `session-${id}`);
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

function node(id: string, parentId: string | undefined, createdAt = "2025-01-01T00:00:00.000Z", sourceSessionName = "src"): ContextLedgerNode {
  return {
    version: 1, id, parentId, sourceSessionName, createdAt,
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
    expect(md).toContain("## Decisions from prior session");
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
    expect(prompt).not.toContain("## Context:");
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
  it("nested chain renders [0] root / [1] child / [2] grandchild", () => {
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
    expect(rows.map((r) => r.number)).toEqual(["[0]", "[1]", "[2]"]);
    expect(rows.map((r) => r.prefix)).toEqual(["", "└── ", "    └── "]);
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

  it("agents launched without context render as separate roots", () => {
    const root = makeSession("root");
    const iso = makeSession("iso", root.getSessionFile()!);
    root.appendCustomEntry(CONTEXT_LINK_ENTRY, { ...link(root, iso, undefined), stage: "ready" });
    root.appendMessage({ role: "assistant", content: [{ type: "text", text: "ok" }], provider: "test", model: "basic", stopReason: "stop" } as never);

    const graph = loadLedgerGraph(root.getSessionFile()!);
    const rows = computeTreeRows(graph, root.getSessionFile()!);
    expect(rows.map((r) => r.number)).toEqual(["[0a]", "[0b]"]);
    expect(rows.map((r) => r.prefix)).toEqual(["", ""]);
    expect(rows[1]!.kind).toBe("session");
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
    expect(rows.map((r) => r.number)).toEqual(["[0]", "[1]"]);
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
    expect(rows[0]!.node?.id).toBe("LA"); // current row directly carries its context

    // Re-rooted at main (h): A, the verify agent, and the isolated orphan
    // each render exactly once — no repeated nesting.
    const mainRows = computeTreeRows(graph, main.getSessionFile()!);
    const numbers = mainRows.map((r) => r.number);
    expect(numbers).toEqual(["[0a]", "[1a]", "[1b]", "[0b]"]);
  });
});

// ---- Context payload + TUI render checks -------------------------------------
// Scenario gallery: deterministic fixtures for every relationship in
// olive-agents-evolution.md, driven through the REAL TUI components with a
// fake terminal. Structural assertions always run; set OLIVE_CONTEXT_VISUAL=1
// to additionally print each captured render and the exact agent payload:
//
//   OLIVE_CONTEXT_VISUAL=1 npx vitest run extensions/olive-agents/test/context-ledger.test.ts --disableConsoleIntercept --no-color
//   (Vitest intercepts console output by default — --disableConsoleIntercept is required for dumps to appear.)

const T0 = "2025-01-01T00:00:00.000Z";
const T1 = "2025-01-02T00:00:00.000Z";
const T2 = "2025-01-03T00:00:00.000Z";
const ENTER = "\r";
const ESC = "\u001b";
const FIXED_SUMMARY = "The implementation plan was accepted. Preserve the previous decision and continue with the next slice.";
const FIXED_INSTRUCTIONS = "Review the next implementation slice without changing the accepted work.";

/** Print a captured render when visual review is requested. */
function dumpVisual(label: string, lines: string[]): void {
  if (process.env.OLIVE_CONTEXT_VISUAL !== "1") return;
  console.log(`\n===== ${label} =====`);
  for (const line of lines) console.log(line);
}

/** Print an exact payload string (e.g. the agent prompt) for visual review. */
function dumpText(label: string, text: string): void {
  if (process.env.OLIVE_CONTEXT_VISUAL !== "1") return;
  console.log(`\n===== ${label} =====`);
  console.log(text);
}

/** Every rendered line must stay within the fixed terminal width. */
function expectFits(lines: string[], width = 100): void {
  for (const line of lines) {
    if (visibleWidth(line) > width && process.env.OLIVE_CONTEXT_VISUAL === "1") {
      console.log(`[width-overflow] ${visibleWidth(line)}: ${JSON.stringify(line)}`);
    }
    expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  }
}

interface CapturedComponent {
  render(width?: number): string[];
  input(data: string): void;
  resolve(): unknown;
  isSettled(): boolean;
}

/** ANSI-free theme: styles pass text through unchanged so renders are plain. */
function fakeTuiTheme() {
  return { fg: (_color: string, s: string) => s, bold: (s: string) => s };
}

/**
 * Drive a real custom-TUI component with a fake ctx.ui.custom: the factory is
 * invoked with a stub terminal, the returned component is retained, and the
 * underlying promise is left open so `done(...)` values stay inspectable.
 */
function captureCustom<R>(open: (ctx: any) => Promise<R>): CapturedComponent {
  let component: { render(width: number): string[]; handleInput(data: string): void } | undefined;
  let resolved: R | undefined;
  let settled = false;
  const ctx: any = {
    ui: {
      custom: (factory: (tui: any, theme: any, kb: any, done: (value: R) => void) => any) => {
        component = factory({ requestRender: () => {} }, fakeTuiTheme(), {}, (value: R) => {
          settled = true;
          resolved = value;
        });
        return new Promise<R>(() => { /* left open: we drive the component directly */ });
      },
      notify: () => {},
    },
  };
  const promise = open(ctx);
  void promise;
  return {
    render: (width = 100) => {
      if (!component) throw new Error("capture: ui.custom factory never invoked");
      return component.render(width);
    },
    input: (data: string) => {
      if (!component) throw new Error("capture: ui.custom factory never invoked");
      component.handleInput(data);
    },
    resolve: () => resolved,
    isSettled: () => settled,
  };
}

interface TreeCapture extends CapturedComponent {
  focusCalls: TreeRow[];
  startCalls: TreeRow[];
}

/** Capture the real /ot + inheritance context tree (openContextTree). */
function captureContextTree(input: Omit<ContextTreeInput, "ctx">): TreeCapture {
  const focusCalls: TreeRow[] = [];
  const startCalls: TreeRow[] = [];
  const cap = captureCustom<string | undefined>((ctx) =>
    openContextTree({
      ...input,
      ctx,
      focusOrOpen: async (row) => { focusCalls.push(row); },
      startNewAgent: async (row) => { startCalls.push(row); },
    }),
  );
  return { ...cap, focusCalls, startCalls };
}

/** Capture the real launch message-selection TUI (buildContextUI). */
function captureContextSelection(branch: SessionEntry[]): CapturedComponent {
  return captureCustom((ctx) => buildContextUI({ ctx, branch }) as Promise<any>);
}

/** Conversation with user/assistant text interspersed with tool noise. */
function seedMessages(sm: SM): { userObjective: string; assistantPlan: string; assistantDecision: string } {
  const userObjective = sm.appendMessage({ role: "user", content: "Define the ledger scenario requirements." });
  sm.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "" }, { type: "tool_use", id: "tu1", name: "read", input: { path: "src/a.ts" } }],
  } as never);
  sm.appendMessage({ role: "toolResult", toolCallId: "tu1", toolName: "read", content: [{ type: "text", text: "file body noise" }] } as never);
  const assistantPlan = sm.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Implementation plan: build the ledger scenarios stub first." }],
  } as never);
  const assistantDecision = sm.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Decision: keep inheritance guided by parentId only; never merge unrelated branches." }],
  } as never);
  return { userObjective, assistantPlan, assistantDecision };
}

describe("finalized ledger context (what goes into the agent)", () => {
  it("isolated launch: instructions unchanged, no ledger node", () => {
    const result = finalizeLedgerContext({
      instructions: FIXED_INSTRUCTIONS,
      branch: [],
      sourceSessionName: "B1 plan",
      nodeId: "DRAFT",
      createdAt: T0,
    });
    expect(result).toEqual({ prompt: FIXED_INSTRUCTIONS, ledgerNode: undefined });
    dumpText("isolated / agent payload", result.prompt);
  });

  it("selected-only: branch-ordered snapshots, no summary, no inheritance", () => {
    const sm = makeSession("B1-plan", undefined, "B1 plan");
    const { userObjective, assistantPlan } = seedMessages(sm);
    const result = finalizeLedgerContext({
      instructions: FIXED_INSTRUCTIONS,
      built: { selectedIds: [assistantPlan, userObjective], summary: undefined, inheritedNodes: [] },
      branch: sm.getBranch(),
      sourceSessionFile: sm.getSessionFile(),
      sourceSessionName: "B1 plan",
      nodeId: "DRAFT",
      createdAt: T0,
    });
    const ledgerNode = result.ledgerNode!;
    expect(ledgerNode).toMatchObject({
      version: 1, id: "DRAFT", sourceSessionName: "B1 plan", createdAt: T0,
    });
    expect(ledgerNode.parentId).toBeUndefined();
    expect(ledgerNode.summary).toBeUndefined();
    // Snapshots follow branch order, not selection order.
    expect(ledgerNode.selections.map((s) => s.entryId)).toEqual([userObjective, assistantPlan]);
    expect(result.prompt).toContain("# context");
    expect(result.prompt).toContain("Implementation plan: build the ledger scenarios stub first.");
    expect(result.prompt).not.toContain("file body noise");
    expect(result.prompt).not.toContain("Inherited context");
    expect(result.prompt.endsWith(`# instructions\n${FIXED_INSTRUCTIONS}`)).toBe(true);
    dumpText("selected-only / agent payload", result.prompt);
  });

  it("summary-only: no snapshots, summary embedded, fresh root", () => {
    const sm = makeSession("B1-plan", undefined, "B1 plan");
    seedMessages(sm);
    const result = finalizeLedgerContext({
      instructions: FIXED_INSTRUCTIONS,
      built: { selectedIds: [], summary: FIXED_SUMMARY, inheritedNodes: [] },
      branch: sm.getBranch(),
      sourceSessionName: "B1 plan",
      nodeId: "DRAFT",
      createdAt: T0,
    });
    const ledgerNode = result.ledgerNode!;
    expect(ledgerNode.summary).toBe(FIXED_SUMMARY);
    expect(ledgerNode.selections).toEqual([]);
    expect(ledgerNode.parentId).toBeUndefined();
    expect(result.prompt).toContain("## Decisions from prior session");
    expect(result.prompt).toContain(FIXED_SUMMARY);
    expect(result.prompt).not.toContain("Selected messages");
    dumpText("summary-only / agent payload", result.prompt);
  });

  it("inherit-only: parentId = inherited leaf; prompt carries the inherited chain only", () => {
    const result = finalizeLedgerContext({
      instructions: FIXED_INSTRUCTIONS,
      built: {
        selectedIds: [],
        inheritedNodes: [node("L0", undefined, T0, "B1 plan"), node("L1", "L0", T1, "B1 plan")],
      },
      branch: [],
      sourceSessionName: "B1 plan",
      nodeId: "DRAFT",
      createdAt: T2,
    });
    expect(result.ledgerNode!.parentId).toBe("L1");
    expect(result.ledgerNode!.selections).toEqual([]);
    expect(result.prompt).toContain("## Inherited context 1: B1 plan");
    expect(result.prompt).toContain("## Inherited context 2: B1 plan");
    // The empty new node contributes no block, so there is no fresh context header.
    expect(result.prompt).not.toContain("## Context:");
    dumpText("inherit-only / agent payload", result.prompt);
  });

  it("combined: inherited chain, summary, and selections stay in order", () => {
    const sm = makeSession("B1-plan", undefined, "B1 plan");
    const { userObjective, assistantPlan } = seedMessages(sm);
    const result = finalizeLedgerContext({
      instructions: FIXED_INSTRUCTIONS,
      built: {
        selectedIds: [userObjective, assistantPlan],
        summary: FIXED_SUMMARY,
        inheritedNodes: [node("L0", undefined, T0, "B1 plan"), node("L1", "L0", T1, "B1 plan")],
      },
      branch: sm.getBranch(),
      sourceSessionName: "B1 plan",
      nodeId: "DRAFT",
      createdAt: T2,
    });
    expect(result.ledgerNode!.parentId).toBe("L1");
    expect(result.ledgerNode!.summary).toBe(FIXED_SUMMARY);
    // Everything here is deterministic, so assert the EXACT prompt string —
    // this is the precise payload that would enter the agent.
    const expected = [
      "# context",
      "## Inherited context 1: B1 plan",
      "## Selected messages",
      "### user (m1)",
      "hello world",
      "",
      "## Inherited context 2: B1 plan",
      "## Selected messages",
      "### user (m1)",
      "hello world",
      "",
      "## Decisions from prior session",
      FIXED_SUMMARY,
      "",
      "## Selected messages",
      `### user (${userObjective})`,
      "Define the ledger scenario requirements.",
      "",
      `### assistant (${assistantPlan})`,
      "Implementation plan: build the ledger scenarios stub first.",
      "",
      "# instructions",
      FIXED_INSTRUCTIONS,
    ].join("\n");
    expect(result.prompt).toBe(expected);
    dumpText("combined / agent payload", result.prompt);
  });

  it("tool noise: tool calls and results never enter the node or prompt", () => {
    const sm = makeSession("B1-plan", undefined, "B1 plan");
    const ids = seedMessages(sm);
    // Select every message id, tool entries included: they must be skipped.
    const all = sm.getBranch().filter((e) => e.type === "message").map((e) => e.id);
    const result = finalizeLedgerContext({
      instructions: FIXED_INSTRUCTIONS,
      built: { selectedIds: all, inheritedNodes: [] },
      branch: sm.getBranch(),
      sourceSessionName: "B1 plan",
      nodeId: "DRAFT",
      createdAt: T0,
    });
    expect(result.ledgerNode!.selections.map((s) => s.entryId))
      .toEqual([ids.userObjective, ids.assistantPlan, ids.assistantDecision]);
    expect(result.prompt).not.toContain("file body noise");
    expect(result.prompt).not.toContain("src/a.ts");
    dumpText("tool-noise / agent payload", result.prompt);
  });
});

describe("context tree + TUI rendering (scenario gallery)", () => {
  it("fresh context root: selected context without inheritance attaches under its source session", async () => {
    const b1 = makeSession("B1-plan", undefined, "B1 plan");
    const child = makeSession("B2-implement", b1.getSessionFile()!, "B2 implement");
    const freshNode = { ...node("L_NEW", undefined, T1, "B1 plan"), sourceSessionFile: b1.getSessionFile()! };
    withLedger(child, freshNode);
    b1.appendCustomEntry(CONTEXT_LINK_ENTRY, { ...link(b1, child, freshNode), stage: "ready" });
    b1.appendMessage({ role: "assistant", content: [{ type: "text", text: "ok" }], provider: "test", model: "basic", stopReason: "stop" } as never);

    const graph = loadLedgerGraph(b1.getSessionFile()!, readSessionEntries, sessionDisplayName);
    expect(computeTreeRows(graph, b1.getSessionFile()!).map((r) => r.number)).toEqual(["[0]", "[1]"]);

    // Opening the inherit picker from the launching session B1: B2 must render
    // attached beneath B1, so the view must anchor at B1 alone (not at B2).
    const cap = captureContextTree({
      graph,
      ancestorFiles: [b1.getSessionFile()!],
      currentFile: b1.getSessionFile()!,
      mode: "select",
    });
    const lines = cap.render();
    dumpVisual("fresh-root / inherit picker", lines);
    expectFits(lines);
    expect(lines.join("\n")).toContain("Choose context");
    expect(lines.join("\n")).toContain("B2 implement");
  });

  it("nested: [0]→[1]→[2]; picker + /ot from root and from a child (h parent)", async () => {
    const b1 = makeSession("B1-plan", undefined, "B1 plan");
    const b2 = makeSession("B2-implement", b1.getSessionFile()!, "B2 implement");
    withLedger(b2, node("L0", undefined, T0, "B1 plan"));
    const b3 = makeSession("B3-review", b2.getSessionFile()!, "B3 review");
    withLedger(b3, node("L1", "L0", T1, "B2 implement"));
    b1.appendCustomEntry(CONTEXT_LINK_ENTRY, { ...link(b1, b2, node("L0", undefined, T0, "B1 plan")), stage: "ready" });
    b2.appendCustomEntry(CONTEXT_LINK_ENTRY, { ...link(b2, b3, node("L1", "L0", T1, "B2 implement")), stage: "ready" });
    b1.appendMessage({ role: "assistant", content: [{ type: "text", text: "ok" }], provider: "test", model: "basic", stopReason: "stop" } as never);

    const graph = loadLedgerGraph(b1.getSessionFile()!, readSessionEntries, sessionDisplayName);
    const rows = computeTreeRows(graph, b1.getSessionFile()!);
    expect(rows.map((r) => r.number)).toEqual(["[0]", "[1]", "[2]"]);
    expect(rows.map((r) => r.prefix)).toEqual(["", "└── ", "    └── "]);

    // Launch inheritance picker from the root: no parent available.
    const picker = captureContextTree({ graph, ancestorFiles: [b1.getSessionFile()!], currentFile: b1.getSessionFile()!, mode: "select" });
    const pick = picker.render();
    dumpVisual("nested / inherit picker", pick);
    expectFits(pick);
    expect(pick.join("\n")).toContain("Choose context");
    expect(pick.join("\n")).toContain("[1]");
    expect(pick.join("\n")).toContain("[2]");
    expect(pick.join("\n")).not.toContain("h parent");

    // /ot from the root: full tree, no h.
    const ot = captureContextTree({ graph, ancestorFiles: [b1.getSessionFile()!], currentFile: b1.getSessionFile()! });
    const otLines = ot.render();
    dumpVisual("nested / /ot from B1", otLines);
    expectFits(otLines);
    const otText = otLines.join("\n");
    expect(otText).toContain("Agent context tree");
    expect(otText).toContain("B2 implement");
    expect(otText).not.toContain("h parent");

    // /ot from B2: ancestors hidden, B2 + its descendant shown, h available.
    const fromB2 = captureContextTree({
      graph,
      ancestorFiles: [b1.getSessionFile()!, b2.getSessionFile()!],
      currentFile: b2.getSessionFile()!,
      currentLedgerId: "L0",
    });
    const b2Lines = fromB2.render();
    dumpVisual("nested / /ot from B2", b2Lines);
    expect(b2Lines.join("\n")).toContain("h parent");
    expect(b2Lines.join("\n")).toContain("B2 implement");
    expect(b2Lines.join("\n")).toContain("B3 review");
    expect(b2Lines.join("\n")).not.toContain("B1 plan");

    // h walks to the root view: B1 visible again, h disappears.
    fromB2.input("h");
    const b2Parent = fromB2.render();
    dumpVisual("nested / /ot from B2 after h", b2Parent);
    expect(b2Parent.join("\n")).toContain("B1 plan");
    expect(b2Parent.join("\n")).toContain("B3 review");
    expect(b2Parent.join("\n")).not.toContain("h parent");
  });

  it("deep child invocation: /ot from B3 walks up with repeated h", async () => {
    const b1 = makeSession("B1-plan", undefined, "B1 plan");
    const b2 = makeSession("B2-implement", b1.getSessionFile()!, "B2 implement");
    withLedger(b2, node("L0", undefined, T0, "B1 plan"));
    const b3 = makeSession("B3-review", b2.getSessionFile()!, "B3 review");
    withLedger(b3, node("L1", "L0", T1, "B2 implement"));
    b1.appendCustomEntry(CONTEXT_LINK_ENTRY, { ...link(b1, b2, node("L0", undefined, T0, "B1 plan")), stage: "ready" });
    b2.appendCustomEntry(CONTEXT_LINK_ENTRY, { ...link(b2, b3, node("L1", "L0", T1, "B2 implement")), stage: "ready" });
    b1.appendMessage({ role: "assistant", content: [{ type: "text", text: "ok" }], provider: "test", model: "basic", stopReason: "stop" } as never);

    const graph = loadLedgerGraph(b3.getSessionFile()!, readSessionEntries, sessionDisplayName);
    const cap = captureContextTree({
      graph,
      ancestorFiles: [b1.getSessionFile()!, b2.getSessionFile()!, b3.getSessionFile()!],
      currentFile: b3.getSessionFile()!,
      currentLedgerId: "L1",
    });
    let lines = cap.render();
    dumpVisual("deep / /ot from B3", lines);
    expectFits(lines);
    expect(lines.join("\n")).toContain("B3 review");
    expect(lines.join("\n")).not.toContain("B1 plan");
    cap.input("h");
    lines = cap.render();
    dumpVisual("deep / /ot from B3 after one h", lines);
    expect(lines.join("\n")).toContain("B2 implement");
    cap.input("h");
    lines = cap.render();
    dumpVisual("deep / /ot from B3 after two h", lines);
    expect(lines.join("\n")).toContain("B1 plan");
    expect(lines.join("\n")).not.toContain("h parent");
  });

  it("parallel: [0] → [1a] [1b]; picker returns the focused inherited id", async () => {
    const b1 = makeSession("B1-plan", undefined, "B1 plan");
    withLedger(b1, node("L0", undefined, T0, "B1 plan"));
    const a = makeSession("B2A", b1.getSessionFile()!, "B2a");
    withLedger(a, node("L1A", "L0", T1, "B1 plan"));
    const b = makeSession("B2B", b1.getSessionFile()!, "B2b");
    withLedger(b, node("L1B", "L0", T2, "B1 plan"));
    b1.appendCustomEntry(CONTEXT_LINK_ENTRY, { ...link(b1, a, node("L1A", "L0")), stage: "ready" });
    b1.appendCustomEntry(CONTEXT_LINK_ENTRY, { ...link(b1, b, node("L1B", "L0")), stage: "ready" });
    b1.appendMessage({ role: "assistant", content: [{ type: "text", text: "ok" }], provider: "test", model: "basic", stopReason: "stop" } as never);

    const graph = loadLedgerGraph(b1.getSessionFile()!, readSessionEntries, sessionDisplayName);
    const rows = computeTreeRows(graph, b1.getSessionFile()!);
    expect(rows.map((r) => r.number)).toEqual(["[0]", "[1a]", "[1b]"]);
    expect(rows.map((r) => r.prefix)).toEqual(["", "├── ", "└── "]);

    const picker = captureContextTree({ graph, ancestorFiles: [b1.getSessionFile()!], currentFile: b1.getSessionFile()!, mode: "select" });
    const lines = picker.render();
    dumpVisual("parallel / inherit picker", lines);
    expectFits(lines);
    expect(lines.join("\n")).toContain("[1a]");
    expect(lines.join("\n")).toContain("[1b]");
    picker.input("j"); // focus the first parallel child
    picker.input(ENTER);
    expect(picker.resolve()).toBe("inherit:L1A");

    const ot = captureContextTree({ graph, ancestorFiles: [b1.getSessionFile()!], currentFile: b1.getSessionFile()! });
    const otLines = ot.render();
    dumpVisual("parallel / /ot from B1", otLines);
    expect(otLines.join("\n")).toContain("[1a]");
    expect(otLines.join("\n")).toContain("[1b]");
  });

  it("skipped parent: B3 launches from B2 but inherits B1's ledger → level with B2", async () => {
    const b1 = makeSession("B1-plan", undefined, "B1 plan");
    withLedger(b1, node("L0", undefined, T0, "B1 plan"));
    const b2 = makeSession("B2-implement", b1.getSessionFile()!, "B2 implement");
    withLedger(b2, node("L_a", "L0", T1, "B1 plan"));
    const b3 = makeSession("B3-review", b2.getSessionFile()!, "B3 review");
    withLedger(b3, node("L_b", "L0", T2, "B1 plan"));
    b1.appendCustomEntry(CONTEXT_LINK_ENTRY, { ...link(b1, b2, node("L_a", "L0")), stage: "ready" });
    b2.appendCustomEntry(CONTEXT_LINK_ENTRY, { ...link(b2, b3, node("L_b", "L0")), stage: "ready" });
    b1.appendMessage({ role: "assistant", content: [{ type: "text", text: "ok" }], provider: "test", model: "basic", stopReason: "stop" } as never);

    const graph = loadLedgerGraph(b1.getSessionFile()!, readSessionEntries, sessionDisplayName);
    const rows = computeTreeRows(graph, b1.getSessionFile()!);
    expect(rows.map((r) => r.number)).toEqual(["[0]", "[1a]", "[1b]"]);
    expect(rows[1]!.node!.id).toBe("L_a");
    expect(rows[2]!.node!.id).toBe("L_b");

    const ot = captureContextTree({ graph, ancestorFiles: [b1.getSessionFile()!], currentFile: b1.getSessionFile()! });
    const lines = ot.render();
    dumpVisual("skipped-parent / /ot from B1", lines);
    expectFits(lines);
    expect(lines.join("\n")).toContain("[1a]");
    expect(lines.join("\n")).toContain("[1b]");
  });

  it("isolated child: no ledger → separate root; picker marks it no-context", async () => {
    const b1 = makeSession("B1-plan", undefined, "B1 plan");
    const iso = makeSession("B2-iso", b1.getSessionFile()!, "B2 isolated");
    b1.appendCustomEntry(CONTEXT_LINK_ENTRY, { ...link(b1, iso, undefined), stage: "ready" });
    b1.appendMessage({ role: "assistant", content: [{ type: "text", text: "ok" }], provider: "test", model: "basic", stopReason: "stop" } as never);
    iso.appendMessage({ role: "assistant", content: [{ type: "text", text: "ok" }], provider: "test", model: "basic", stopReason: "stop" } as never);

    const graph = loadLedgerGraph(b1.getSessionFile()!, readSessionEntries, sessionDisplayName);
    const rows = computeTreeRows(graph, b1.getSessionFile()!);
    expect(rows.map((r) => r.number)).toEqual(["[0a]", "[0b]"]);
    expect(rows.map((r) => r.kind)).toEqual(["session", "session"]);

    const picker = captureContextTree({ graph, ancestorFiles: [b1.getSessionFile()!], currentFile: b1.getSessionFile()!, mode: "select" });
    const pick = picker.render();
    dumpVisual("isolated / inherit picker", pick);
    expectFits(pick);
    expect(pick.join("\n")).toContain("— no context");

    const ot = captureContextTree({ graph, ancestorFiles: [b1.getSessionFile()!], currentFile: b1.getSessionFile()! });
    const otLines = ot.render();
    dumpVisual("isolated / /ot from B1", otLines);
    expect(otLines.join("\n")).toContain("B2 isolated");
    expect(otLines.join("\n")).toContain("[0b]");
  });

  it("isolated grandchild: B3 launched by B2 without context → separate root despite session nesting", async () => {
    const b1 = makeSession("B1-plan", undefined, "B1 plan");
    withLedger(b1, node("L0", undefined, T0, "B1 plan"));
    const b2 = makeSession("B2-implement", b1.getSessionFile()!, "B2 implement");
    withLedger(b2, node("L_a", "L0", T1, "B1 plan"));
    const b3 = makeSession("B3-iso", b2.getSessionFile()!, "B3 isolated");
    b1.appendCustomEntry(CONTEXT_LINK_ENTRY, { ...link(b1, b2, node("L_a", "L0")), stage: "ready" });
    b2.appendCustomEntry(CONTEXT_LINK_ENTRY, { ...link(b2, b3, undefined), stage: "ready" });
    b1.appendMessage({ role: "assistant", content: [{ type: "text", text: "ok" }], provider: "test", model: "basic", stopReason: "stop" } as never);
    b2.appendMessage({ role: "assistant", content: [{ type: "text", text: "ok" }], provider: "test", model: "basic", stopReason: "stop" } as never);
    b3.appendMessage({ role: "assistant", content: [{ type: "text", text: "ok" }], provider: "test", model: "basic", stopReason: "stop" } as never);

    const graph = loadLedgerGraph(b1.getSessionFile()!, readSessionEntries, sessionDisplayName);
    const rows = computeTreeRows(graph, b1.getSessionFile()!);
    // Context child B2 sits under B1; the isolated B3 renders as a separate
    // root even though its session-header parent is B2 (evolution-doc case 3).
    expect(rows.map((r) => r.number)).toEqual(["[0a]", "[1]", "[0b]"]);
    expect(rows.map((r) => r.kind)).toEqual(["context", "context", "session"]);
    expect(rows[2]!.sessionFile).toBe(b3.getSessionFile()!);
    expect(rows[2]!.parentFile).toBe(b2.getSessionFile()!); // launched by B2, still isolated

    const ot = captureContextTree({ graph, ancestorFiles: [b1.getSessionFile()!], currentFile: b1.getSessionFile()! });
    const lines = ot.render();
    dumpVisual("isolated-grandchild / /ot from B1", lines);
    expectFits(lines);
    expect(lines.join("\n")).toContain("B3 isolated");
    expect(lines.join("\n")).toContain("[0b]");
    expect(lines.join("\n")).toContain("[1]");
  });

  it("mixed: context chain plus isolated root stay visible", async () => {
    const b1 = makeSession("B1-plan", undefined, "B1 plan");
    withLedger(b1, node("L0", undefined, T0, "B1 plan"));
    const ctx = makeSession("B2-implement", b1.getSessionFile()!, "B2 implement");
    withLedger(ctx, node("L1", "L0", T1, "B1 plan"));
    const iso = makeSession("B3-iso", b1.getSessionFile()!, "B3 isolated");
    b1.appendCustomEntry(CONTEXT_LINK_ENTRY, { ...link(b1, ctx, node("L1", "L0")), stage: "ready" });
    b1.appendCustomEntry(CONTEXT_LINK_ENTRY, { ...link(b1, iso, undefined), stage: "ready" });
    b1.appendMessage({ role: "assistant", content: [{ type: "text", text: "ok" }], provider: "test", model: "basic", stopReason: "stop" } as never);
    iso.appendMessage({ role: "assistant", content: [{ type: "text", text: "ok" }], provider: "test", model: "basic", stopReason: "stop" } as never);

    const graph = loadLedgerGraph(b1.getSessionFile()!, readSessionEntries, sessionDisplayName);
    const rows = computeTreeRows(graph, b1.getSessionFile()!);
    expect(rows.map((r) => r.number)).toEqual(["[0a]", "[1]", "[0b]"]);
    expect(rows.map((r) => r.prefix)).toEqual(["", "└── ", ""]);

    const ot = captureContextTree({ graph, ancestorFiles: [b1.getSessionFile()!], currentFile: b1.getSessionFile()! });
    const lines = ot.render();
    dumpVisual("mixed / /ot from B1", lines);
    expectFits(lines);
    expect(lines.join("\n")).toContain("B2 implement");
    expect(lines.join("\n")).toContain("B3 isolated");
  });

  it("cycle guard: mutual links render each session once and terminate", async () => {
    const a = makeSession("A", undefined, "A");
    const b = makeSession("B", a.getSessionFile()!, "B");
    withLedger(b, node("LB", undefined, T1, "A"));
    a.appendCustomEntry(CONTEXT_LINK_ENTRY, { ...link(a, b, node("LB", undefined)), stage: "ready" });
    b.appendCustomEntry(CONTEXT_LINK_ENTRY, { ...link(b, a, undefined), stage: "ready" });
    a.appendMessage({ role: "assistant", content: [{ type: "text", text: "ok" }], provider: "test", model: "basic", stopReason: "stop" } as never);
    b.appendMessage({ role: "assistant", content: [{ type: "text", text: "ok" }], provider: "test", model: "basic", stopReason: "stop" } as never);

    const graph = loadLedgerGraph(a.getSessionFile()!, readSessionEntries, sessionDisplayName);
    const rows = computeTreeRows(graph, a.getSessionFile()!);
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.label)).toEqual(["A", "B"]);

    const ot = captureContextTree({ graph, ancestorFiles: [a.getSessionFile()!], currentFile: a.getSessionFile()! });
    const lines = ot.render();
    dumpVisual("cycle / /ot from A", lines);
    expectFits(lines);
    expect(lines.join("\n")).toContain("A");
    expect(lines.join("\n")).toContain("B");
  });

  it("combined payload lands in /ot via a synthetic child (no agent)", async () => {
    // B1 is an agent session that already holds its own ledger node L0 (it was
    // itself launched with fresh context); the user is now IN B1 building the
    // child's context on top of B1's real persisted node.
    const b1 = makeSession("B1-plan", undefined, "B1 plan");
    withLedger(b1, node("L0", undefined, T0, "B1 plan"));
    const { userObjective, assistantPlan } = seedMessages(b1);
    const inherited = [node("L0", undefined, T0, "B1 plan")]; // B1's own node
    const finalized = finalizeLedgerContext({
      instructions: FIXED_INSTRUCTIONS,
      built: { selectedIds: [userObjective, assistantPlan], summary: FIXED_SUMMARY, inheritedNodes: inherited },
      branch: b1.getBranch(),
      sourceSessionFile: b1.getSessionFile(),
      sourceSessionName: "B1 plan",
      nodeId: "DRAFT",
      createdAt: T2,
    });
    expect(finalized.ledgerNode!.id).toBe("DRAFT");
    expect(finalized.ledgerNode!.parentId).toBe("L0");

    // Simulate only the persistence result of a post-launch /ot: the child
    // session holds the ledger node, the source session holds the ready link.
    const child = makeSession("B2-implement", b1.getSessionFile()!, "B2 implement");
    child.appendCustomEntry(CONTEXT_LEDGER_ENTRY, { version: 1, node: finalized.ledgerNode });
    b1.appendCustomEntry(CONTEXT_LINK_ENTRY, { ...link(b1, child, finalized.ledgerNode), stage: "ready" });
    b1.appendMessage({ role: "assistant", content: [{ type: "text", text: "ok" }], provider: "test", model: "basic", stopReason: "stop" } as never);
    child.appendMessage({ role: "assistant", content: [{ type: "text", text: "ok" }], provider: "test", model: "basic", stopReason: "stop" } as never);

    const graph = loadLedgerGraph(b1.getSessionFile()!, readSessionEntries, sessionDisplayName);
    expect(computeTreeRows(graph, b1.getSessionFile()!).map((r) => r.number)).toEqual(["[0]", "[1]"]);
    dumpText("combined / agent payload", finalized.prompt);

    // Same anchor correction: /ot from the launching session roots at B1, so
    // the new child renders beneath it (j then opens B2's row actions).
    const ot = captureContextTree({ graph, ancestorFiles: [b1.getSessionFile()!], currentFile: b1.getSessionFile()! });
    let lines = ot.render();
    dumpVisual("combined / post-build /ot", lines);
    expectFits(lines);
    expect(lines.join("\n")).toContain("B2 implement");

    // Action menu on the child row (row 1 after one j).
    ot.input("j");
    ot.input(ENTER);
    const menu = ot.render();
    dumpVisual("combined / /ot action menu", menu);
    expect(menu.join("\n")).toContain("View context");
    expect(menu.join("\n")).toContain("Open agent session");
    expect(menu.join("\n")).toContain("Start new agent");

    // View context: inherited path, compacted summary, selected messages.
    ot.input(ENTER);
    const detail = ot.render();
    dumpVisual("combined / /ot context detail", detail);
    const detailText = detail.join("\n");
    expect(detailText).toContain("Context path:");
    expect(detailText).toContain("B1 plan");
    // The summary is width-wrapped in the render, so assert a wrap-safe span.
    expect(detailText).toContain("Preserve the previous decision and continue");
    expect(detailText).toContain("Selected messages");

    // Back to browse, then Open agent session routes the focused row.
    ot.input("q");
    ot.input(ENTER);
    ot.input("j");
    ot.input(ENTER);
    expect(ot.focusCalls).toHaveLength(1);
    expect(ot.focusCalls[0]).toMatchObject({ sessionFile: child.getSessionFile() });

    // The same ledger row can start a new child without leaving /ot.
    await Promise.resolve();
    ot.input(ENTER);
    ot.input("j");
    ot.input("j");
    ot.input(ENTER);
    expect(ot.startCalls).toHaveLength(1);
    expect(ot.startCalls[0]).toMatchObject({ node: finalized.ledgerNode });
    expect(ot.isSettled()).toBe(true);
  });

  it("context selection TUI: live list, selection state, preview, tool noise excluded", async () => {
    const sm = makeSession("B1-plan", undefined, "B1 plan");
    const ids = seedMessages(sm);
    const cap = captureContextSelection(sm.getBranch());
    const lines = cap.render();
    dumpVisual("context selection / initial", lines);
    expectFits(lines);
    const text = lines.join("\n");
    expect(text).toContain("Select context for sendoff");
    expect(text).toContain("no items selected");
    expect(text).toContain("user · Define"); // role label in the list (truncated at the list column width)
    expect(text).toContain("Define the ledger scenario requirements."); // full text in the preview pane
    expect(text).not.toContain("file body noise");

    // Focus the assistant plan and select it.
    cap.input("j");
    cap.input(" ");
    const selected = cap.render();
    dumpVisual("context selection / one selected", selected);
    expect(selected.join("\n")).toContain("1 selected");
    expect(cap.resolve()).toBeUndefined(); // not submitted yet

    // Enter toggles the expanded preview.
    cap.input(ENTER);
    dumpVisual("context selection / expanded preview", cap.render());

    // Escape finishes the selection with the chosen entry ids.
    cap.input(ESC);
    expect(cap.resolve()).toEqual({ selectedIds: [ids.assistantPlan] });
  });
});
