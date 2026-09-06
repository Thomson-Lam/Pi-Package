import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { focusOrOpenParent } from "../src/child-tmux.mjs";

function fakeExec(routes: Record<string, { code: number; stdout?: string }>) {
  const calls: string[][] = [];
  const exec = async (args: string[]) => {
    calls.push(args);
    const result = routes[args.join(" ")] ?? { code: 1, stdout: "" };
    return { code: result.code, stdout: result.stdout ?? "", stderr: "" };
  };
  return { calls, exec };
}

const format = "#{window_id}\t#{session_name}\t#{window_index}\t#{window_name}\t#{@olive-parent-session-file}\t#{@olive-parent-pid}";
const testPane = "%olive-test";
let previousPane: string | undefined;

beforeEach(() => {
  previousPane = process.env.TMUX_PANE;
  process.env.TMUX_PANE = testPane;
});

afterEach(() => {
  if (previousPane === undefined) delete process.env.TMUX_PANE;
  else process.env.TMUX_PANE = previousPane;
});

describe("child parent window handling", () => {
  it("focuses an existing marked parent window", async () => {
    const { calls, exec } = fakeExec({
      [`list-windows -a -F ${format}`]: { code: 0, stdout: `@3\tmain\t1\tparent\t/tmp/parent.jsonl\t${process.pid}\n` },
      "select-window -t @3": { code: 0 },
    });
    expect(await focusOrOpenParent({ parentSessionFile: "/tmp/parent.jsonl", cwd: "/tmp" }, exec)).toBe("focused");
    expect(calls).toEqual([
      ["list-windows", "-a", "-F", format],
      ["select-window", "-t", "@3"],
    ]);
  });

  it("retries a failed focus while the marked parent window still exists", async () => {
    const calls: string[][] = [];
    let selects = 0;
    const exec = async (args: string[]) => {
      calls.push(args);
      if (args[0] === "list-windows") {
        return { code: 0, stdout: `@3\tmain\t1\tparent\t/tmp/parent.jsonl\t${process.pid}\n`, stderr: "" };
      }
      if (args[0] === "select-window" && args[2] === "@3") {
        selects++;
        return { code: selects === 2 ? 0 : 1, stdout: "", stderr: "" };
      }
      if (args[0] === "display-message" && args[3] === "@3") {
        return { code: 0, stdout: "@3\n", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "" };
    };

    expect(await focusOrOpenParent({ parentSessionFile: "/tmp/parent.jsonl", cwd: "/tmp" }, exec)).toBe("focused");
    expect(calls.some((args) => args[0] === "new-window")).toBe(false);
  });

  it("does not open a duplicate when a marked parent window cannot be focused", async () => {
    const { calls, exec } = fakeExec({
      [`list-windows -a -F ${format}`]: { code: 0, stdout: `@3\tmain\t1\tparent\t/tmp/parent.jsonl\t${process.pid}\n` },
      "select-window -t @3": { code: 1 },
      "display-message -p -t @3 #{window_id}": { code: 0, stdout: "@3\n" },
    });

    expect(await focusOrOpenParent({ parentSessionFile: "/tmp/parent.jsonl", cwd: "/tmp" }, exec)).toBe("unavailable");
    expect(calls.some((args) => args[0] === "new-window")).toBe(false);
  });

  it("reopens the parent when the marked window is gone", async () => {
    const { calls, exec } = fakeExec({
      [`list-windows -a -F ${format}`]: { code: 0, stdout: `@3\tmain\t1\tparent\t/tmp/parent.jsonl\t${process.pid}\n` },
      "select-window -t @3": { code: 1 },
      "display-message -p -t %olive-test #{session_id}": { code: 0, stdout: "$0\n" },
      "new-window -d -t $0 -n [P] parent -c /tmp -P -F #{window_id} pi --session '/tmp/parent.jsonl'": { code: 0, stdout: "@7\n" },
      "select-window -t @7": { code: 0 },
    });

    expect(await focusOrOpenParent({ parentSessionFile: "/tmp/parent.jsonl", cwd: "/tmp" }, exec)).toBe("opened");
    expect(calls.some((args) => args[0] === "new-window")).toBe(true);
  });

  it("opens and focuses the parent session when no marked window exists", async () => {
    const { calls, exec } = fakeExec({
      [`list-windows -a -F ${format}`]: { code: 0 },
      "display-message -p -t %olive-test #{session_id}": { code: 0, stdout: "$0\n" },
      "new-window -d -t $0 -n [P] Test-tmux-naming -c /tmp -P -F #{window_id} pi --session '/tmp/parent session.jsonl'": { code: 0, stdout: "@7\n" },
      "select-window -t @7": { code: 0 },
    });
    expect(await focusOrOpenParent({ parentSessionFile: "/tmp/parent session.jsonl", parentWindowName: "Test-tmux-naming", cwd: "/tmp" }, exec)).toBe("opened");
    expect(calls.at(-2)).toEqual(["new-window", "-d", "-t", "$0", "-n", "[P] Test-tmux-naming", "-c", "/tmp", "-P", "-F", "#{window_id}", "pi --session '/tmp/parent session.jsonl'"]);
  });

  it("does nothing when no parent session file or tmux session exists", async () => {
    const noParent = fakeExec({});
    expect(await focusOrOpenParent({ parentSessionFile: undefined, cwd: "/tmp" }, noParent.exec)).toBe("unavailable");

    const noTmux = fakeExec({
      [`list-windows -a -F ${format}`]: { code: 1 },
      "display-message -p -t %olive-test #{session_id}": { code: 1 },
    });
    expect(await focusOrOpenParent({ parentSessionFile: "/tmp/parent.jsonl", cwd: "/tmp" }, noTmux.exec)).toBe("unavailable");
  });
});
