import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { TmuxAdapter } from "../tmux.ts";

const execFileAsync = promisify(execFile);

async function tmux(server: string, args: string[]) {
  try {
    const result = await execFileAsync("tmux", ["-L", server, ...args]);
    return { stdout: result.stdout, stderr: result.stderr, code: 0 };
  } catch (error: any) {
    return { stdout: error.stdout || "", stderr: error.stderr || error.message, code: error.code || 1 };
  }
}

test("real adapter targets only an isolated tmux server", async (t) => {
  const server = `blink-test-${process.pid}-${Date.now()}`;
  const dir = await mkdtemp(join(tmpdir(), "blink-tmux-"));
  t.after(async () => {
    await tmux(server, ["kill-server"]);
    await rm(dir, { recursive: true, force: true });
  });
  const script = join(dir, "wait.lua");
  await writeFile(script, "vim.defer_fn(function() vim.cmd('qa!') end, 10000)\n");
  assert.equal((await tmux(server, ["-f", "/dev/null", "new-session", "-d", "-s", "blink", "-c", dir])).code, 0);
  const owner = (await tmux(server, ["display-message", "-p", "-t", "blink:0.0", "#{pane_id}"])).stdout.trim();
  assert.match(owner, /^%\d+$/);

  const adapter = new TmuxAdapter({
    ownerPane: owner,
    cwd: dir,
    reviewScript: script,
    prefixArgs: ["-L", server],
    exec: (command, args) => command === "tmux" ? tmux(server, args.slice(2)) : Promise.reject(new Error("unexpected command")),
  });
  // The exec helper above removes the adapter's own -L pair before applying the isolated pair.
  const pane = await adapter.create("isolated-review", "blitz", join(dir, "missing.sock"));
  assert.notEqual(pane, owner);
  const panes = (await tmux(server, ["list-panes", "-a", "-F", "#{pane_id}"])).stdout.trim().split("\n");
  assert.deepEqual(new Set(panes), new Set([owner, pane]));
  const active = (await tmux(server, ["display-message", "-p", "-t", pane, "#{pane_active}"])).stdout.trim();
  assert.equal(active, "1");

  await adapter.close();
  const remaining = (await tmux(server, ["list-panes", "-a", "-F", "#{pane_id}"])).stdout.trim().split("\n");
  assert.deepEqual(remaining, [owner]);
});
