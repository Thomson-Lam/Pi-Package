import { describe, expect, it } from "vitest";
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

  it("opens and focuses the parent session when no marked window exists", async () => {
    const { calls, exec } = fakeExec({
      [`list-windows -a -F ${format}`]: { code: 0 },
      "display-message -p #{session_id}": { code: 0, stdout: "$0\n" },
      "new-window -d -t $0 -n olive-parent -c /tmp -P -F #{window_id} pi --session '/tmp/parent session.jsonl'": { code: 0, stdout: "@7\n" },
      "select-window -t @7": { code: 0 },
    });
    expect(await focusOrOpenParent({ parentSessionFile: "/tmp/parent session.jsonl", cwd: "/tmp" }, exec)).toBe("opened");
    expect(calls.at(-2)).toEqual(["new-window", "-d", "-t", "$0", "-n", "olive-parent", "-c", "/tmp", "-P", "-F", "#{window_id}", "pi --session '/tmp/parent session.jsonl'"]);
  });

  it("does nothing when no parent session file or tmux session exists", async () => {
    const noParent = fakeExec({});
    expect(await focusOrOpenParent({ parentSessionFile: undefined, cwd: "/tmp" }, noParent.exec)).toBe("unavailable");

    const noTmux = fakeExec({
      [`list-windows -a -F ${format}`]: { code: 1 },
      "display-message -p #{session_id}": { code: 1 },
    });
    expect(await focusOrOpenParent({ parentSessionFile: "/tmp/parent.jsonl", cwd: "/tmp" }, noTmux.exec)).toBe("unavailable");
  });
});
