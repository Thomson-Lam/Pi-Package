import test from "node:test";
import assert from "node:assert/strict";

import { TmuxAdapter, shellQuote } from "../tmux.ts";

test("shellQuote safely isolates spaces and single quotes", () => {
  assert.equal(shellQuote("a b'c"), `'a b'"'"'c'`);
});

test("creates detached exact-owner right split, marks, verifies, and focuses", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const exec = async (command: string, args: string[]) => {
    calls.push({ command, args });
    if (args.includes("split-window")) return { stdout: "%9\n", stderr: "", code: 0 };
    if (args.includes("display-message")) return { stdout: "review\t%1\treview-id\n", stderr: "", code: 0 };
    return { stdout: "", stderr: "", code: 0 };
  };
  const adapter = new TmuxAdapter({
    ownerPane: "%1",
    cwd: "/tmp/a b",
    reviewScript: "/pkg/review.lua",
    exec,
  });
  const pane = await adapter.create("review-id", "blitz", "/tmp/blink.sock");
  assert.equal(pane, "%9");
  const split = calls.find((call) => call.args.includes("split-window"))!;
  assert.deepEqual(split.args.slice(0, 9), ["split-window", "-d", "-h", "-t", "%1", "-c", "/tmp/a b", "-P", "-F"]);
  assert.match(split.args.at(-1)!, /BLINK_REVIEW_ID='review-id'/);
  assert.match(split.args.at(-1)!, /exec nvim -S '\/pkg\/review.lua'/);
  assert.equal(calls.filter((call) => call.args[0] === "set-option").length, 3);
  assert.deepEqual(calls.at(-1)!.args, ["select-pane", "-t", "%9"]);
});

test("ordinary ensure reuses a verified live pane without focusing", async () => {
  const calls: string[][] = [];
  const exec = async (_command: string, args: string[]) => {
    calls.push(args);
    if (args[0] === "display-message") return { stdout: "review\t%1\tr\n", stderr: "", code: 0 };
    throw new Error("unexpected");
  };
  const adapter = new TmuxAdapter({ ownerPane: "%1", cwd: "/tmp", reviewScript: "/r.lua", exec });
  adapter.adoptForTest("%2", "r");
  assert.equal(await adapter.ensure("r", "blitz", "/s"), "%2");
  assert.equal(calls.some((args) => args[0] === "select-pane"), false);
});

test("cleanup focuses verified owner then kills only verified review pane and is idempotent", async () => {
  const calls: string[][] = [];
  const exec = async (_command: string, args: string[]) => {
    calls.push(args);
    if (args[0] === "display-message") return { stdout: "review\t%1\tr\n", stderr: "", code: 0 };
    return { stdout: "", stderr: "", code: 0 };
  };
  const adapter = new TmuxAdapter({ ownerPane: "%1", cwd: "/tmp", reviewScript: "/r.lua", exec });
  adapter.adoptForTest("%2", "r");
  await adapter.close();
  await adapter.close();
  const focusIndex = calls.findIndex((args) => args[0] === "select-pane");
  const killIndex = calls.findIndex((args) => args[0] === "kill-pane");
  assert(focusIndex >= 0 && killIndex > focusIndex);
  assert.deepEqual(calls[killIndex], ["kill-pane", "-t", "%2"]);
});

test("cleanup refuses mismatched metadata", async () => {
  const calls: string[][] = [];
  const exec = async (_command: string, args: string[]) => {
    calls.push(args);
    return { stdout: "other\t%1\tr\n", stderr: "", code: 0 };
  };
  const adapter = new TmuxAdapter({ ownerPane: "%1", cwd: "/tmp", reviewScript: "/r.lua", exec });
  adapter.adoptForTest("%2", "r");
  await adapter.close();
  assert.equal(calls.some((args) => args[0] === "kill-pane"), false);
});
