/**
 * tmux-window.test.ts — tmux window creation/focus logic with an injected exec.
 */

import { describe, expect, it } from "vitest";
import {
  agentWindowName,
  createAgentWindow,
  currentTmuxSession,
  focusWindow,
  killWindow,
  listWindows,
  maxWindowIndex,
  shellQuote,
  type TmuxExec,
  windowAlive,
} from "../src/tmux-window.js";

function mockExec(routes: Record<string, { code: number; stdout?: string; stderr?: string }>): TmuxExec {
  return async (args: string[]) => {
    const key = args.join(" ");
    const hit = routes[key];
    if (hit) return { code: hit.code, stdout: hit.stdout ?? "", stderr: hit.stderr ?? "", killed: false };
    return { code: 1, stdout: "", stderr: `unmocked: ${key}`, killed: false };
  };
}

describe("shellQuote", () => {
  it("quotes simple values", () => {
    expect(shellQuote("abc")).toBe("'abc'");
  });
  it("escapes single quotes", () => {
    expect(shellQuote("it's")).toBe(`'it'"'"'s'`);
  });
  it("handles spaces and apostrophes together", () => {
    expect(shellQuote("/tmp/a b/'x'")).toBe(`'/tmp/a b/'\"'\"'x'\"'\"''`);
  });
});

describe("agentWindowName", () => {
  it("produces a zellij-style codename with a type slug", () => {
    expect(agentWindowName("a1b2c3d4e5f6g7", "Review")).toMatch(/^[a-z]+-[a-z]+-review$/);
  });
  it("is deterministic per seed", () => {
    expect(agentWindowName("a1b2c3d4e5f6g7", "Review")).toBe(agentWindowName("a1b2c3d4e5f6g7", "Review"));
  });
  it("maps general-purpose to general and sanitizes other types", () => {
    expect(agentWindowName("x", "general-purpose")).toMatch(/-general$/);
    expect(agentWindowName("x", "My Agent/Type!")).toMatch(/-my-agent-type$/);
  });
  it("is bounded in length", () => {
    expect(agentWindowName("a1b2c3d4e5f6g7", "x".repeat(100)).length).toBeLessThanOrEqual(48);
  });
});

describe("window listing + max index", () => {
  it("parses list-windows output", async () => {
    const exec = mockExec({
      "list-windows -t $0 -F #{window_id} #{window_index} #{window_name}":
        { code: 0, stdout: "@0 1 Pi-Package-agent\n@1 2 Pi-Package-servers\n" },
    });
    const windows = await listWindows(exec, "$0");
    expect(windows).toEqual([
      { id: "@0", index: 1, name: "Pi-Package-agent" },
      { id: "@1", index: 2, name: "Pi-Package-servers" },
    ]);
  });

  it("maxWindowIndex handles empty and non-contiguous indices", () => {
    expect(maxWindowIndex([])).toBe(0);
    expect(maxWindowIndex([{ index: 1 }, { index: 5 }, { index: 3 }])).toBe(5);
  });

  it("returns [] when list-windows fails", async () => {
    const exec = mockExec({});
    expect(await listWindows(exec, "$0")).toEqual([]);
  });
});

describe("createAgentWindow", () => {
  it("creates at max+1 and captures the stable id", async () => {
    const exec = mockExec({
      "list-windows -t $0 -F #{window_id} #{window_index} #{window_name}":
        { code: 0, stdout: "@0 1 a\n@1 2 b\n" },
      "new-window -d -t $0 -n my-agent -c /tmp -P -F #{window_id} #{window_index} node /x.mjs /s.json":
        { code: 0, stdout: "@2 3\n" },
      "set-window-option -t @2 automatic-rename off": { code: 0 },
    });
    const created = await createAgentWindow(exec, "$0", {
      name: "my-agent",
      cwd: "/tmp",
      command: "node /x.mjs /s.json",
    });
    expect(created).toEqual({ id: "@2", index: 3, name: "my-agent" });
  });

  it("throws when new-window fails", async () => {
    const exec = mockExec({
      "list-windows -t $0 -F #{window_id} #{window_index} #{window_name}": { code: 0, stdout: "" },
      "new-window -d -t $0 -n a -c /tmp -P -F #{window_id} #{window_index} cmd":
        { code: 1, stderr: "bad window" },
    });
    await expect(createAgentWindow(exec, "$0", { name: "a", cwd: "/tmp", command: "cmd" }))
      .rejects.toThrow(/new-window failed/);
  });

  it("throws on unexpected id output", async () => {
    const exec = mockExec({
      "list-windows -t $0 -F #{window_id} #{window_index} #{window_name}": { code: 0, stdout: "" },
      "new-window -d -t $0 -n a -c /tmp -P -F #{window_id} #{window_index} cmd": { code: 0, stdout: "garbage" },
    });
    await expect(createAgentWindow(exec, "$0", { name: "a", cwd: "/tmp", command: "cmd" }))
      .rejects.toThrow(/unexpected id/);
  });
});

describe("window control by stable id", () => {
  it("focusWindow returns true on success, false on failure", async () => {
    const exec = mockExec({
      "select-window -t @2": { code: 0 },
      "select-window -t @99": { code: 1 },
    });
    expect(await focusWindow(exec, "@2")).toBe(true);
    expect(await focusWindow(exec, "@99")).toBe(false);
  });

  it("windowAlive probes by id", async () => {
    const exec = mockExec({
      "display-message -p -t @2 #{window_id}": { code: 0, stdout: "@2" },
      "display-message -p -t @99 #{window_id}": { code: 0, stdout: "" }, // tmux: exit 0, empty output
      "display-message -p -t @100 #{window_id}": { code: 1 }, // tmux error
    });
    expect(await windowAlive(exec, "@2")).toBe(true);
    expect(await windowAlive(exec, "@99")).toBe(false);
    expect(await windowAlive(exec, "@100")).toBe(false);
  });

  it("killWindow returns false when the window is gone", async () => {
    const exec = mockExec({
      "kill-window -t @99": { code: 1 },
    });
    expect(await killWindow(exec, "@99")).toBe(false);
  });
});

describe("currentTmuxSession", () => {
  it("returns undefined outside tmux", async () => {
    const exec = mockExec({});
    // process.env.TMUX may be set in CI tmux; simulate absence.
    const previous = process.env.TMUX;
    delete process.env.TMUX;
    try {
      expect(await currentTmuxSession(exec)).toBeUndefined();
    } finally {
      if (previous !== undefined) process.env.TMUX = previous;
    }
  });
});
