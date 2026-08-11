import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { BlinkRuntime } from "../runtime.ts";

const execFileAsync = promisify(execFile);

async function command(command: string, args: string[]) {
  try {
    const result = await execFileAsync(command, args, { env: process.env });
    return { stdout: result.stdout, stderr: result.stderr, code: 0 };
  } catch (error: any) {
    return { stdout: error.stdout || "", stderr: error.stderr || error.message, code: typeof error.code === "number" ? error.code : 1 };
  }
}

const fakeClientSource = `
import { connect } from "node:net";
import { readFileSync, writeFileSync } from "node:fs";
const action = readFileSync(process.argv[2], "utf8").trim();
const socket = connect(process.env.BLINK_SOCKET_PATH);
let buffer = "";
let counter = 0;
function send(type, payload = {}) {
  socket.write(JSON.stringify({ protocolVersion: 2, type, reviewId: process.env.BLINK_REVIEW_ID, requestId: type + "-" + (++counter), payload }) + "\\n");
}
socket.on("connect", () => { if (action !== "no-ready") send("client_ready", { nvimVersion: "fake" }); });
socket.on("data", (chunk) => {
  buffer += chunk;
  while (buffer.includes("\\n")) {
    const at = buffer.indexOf("\\n");
    const message = JSON.parse(buffer.slice(0, at));
    buffer = buffer.slice(at + 1);
    if (message.type === "hello") send("request_state");
    if (message.type === "state_snapshot" && message.payload.transaction) {
      if (action === "disconnect") socket.end();
      else if (action === "client_closing") send("client_closing", {});
      else if (action === "conflict") {
        writeFileSync(process.env.BLINK_CWD + "/a.txt", "external-newer");
        send("slow_reject", { transactionId: message.payload.transaction.transactionId });
      } else if (action === "slow_comment_keep" || action === "slow_comment_reject") {
        send(action, { transactionId: message.payload.transaction.transactionId, comment: "human note" });
      } else send(action, { transactionId: message.payload.transaction.transactionId });
    }
    if (message.type === "slow_action_result" && (message.payload.settled || message.payload.error)) process.exit(0);
    if (message.type === "shutdown") process.exit(0);
  }
});
setTimeout(() => process.exit(9), 7000).unref();
`;

test("Slow dispositions and Blitz delivery coordinate through isolated tmux and a fake client", async (t) => {
  const server = `blink-coord-${process.pid}-${Date.now()}`;
  const dir = await mkdtemp(join(tmpdir(), "blink-coord-"));
  const oldTmux = process.env.TMUX;
  const oldPane = process.env.TMUX_PANE;
  const oldPath = process.env.PATH;
  t.after(async () => {
    process.env.TMUX = oldTmux;
    process.env.TMUX_PANE = oldPane;
    process.env.PATH = oldPath;
    await command("tmux", ["-L", server, "kill-server"]);
    await rm(dir, { recursive: true, force: true });
  });
  const bin = join(dir, "bin");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(bin));
  const clientScript = join(dir, "fake-client.mjs");
  await writeFile(clientScript, fakeClientSource);
  await writeFile(join(bin, "nvim"), `#!/bin/sh\nexec node ${JSON.stringify(clientScript)} "$2"\n`, { mode: 0o755 });
  process.env.PATH = `${bin}:${oldPath}`;
  assert.equal((await command("tmux", ["-L", server, "-f", "/dev/null", "new-session", "-d", "-s", "blink", "-c", dir])).code, 0);
  const owner = (await command("tmux", ["-L", server, "display-message", "-p", "-t", "blink:0.0", "#{pane_id}"])).stdout.trim();
  const tmuxEnv = (await command("tmux", ["-L", server, "display-message", "-p", "-t", owner, "#{socket_path},#{pid},0"])).stdout.trim();
  process.env.TMUX = tmuxEnv;
  process.env.TMUX_PANE = owner;

  const notifications: string[] = [];
  let aborts = 0;
  const ctx: any = {
    cwd: dir,
    mode: "tui",
    isIdle: () => false,
    abort: () => { aborts++; },
    ui: {
      notify: (message: string) => notifications.push(message),
      setStatus() {},
      theme: { fg: (_name: string, text: string) => text },
    },
  };
  const pi: any = {
    exec: command,
    sendUserMessage() {},
  };
  const sinks = new Map();
  const queue = async (_path: string, operation: () => Promise<any>) => operation();
  const file = join(dir, "a.txt");
  const runtimes: BlinkRuntime[] = [];
  t.after(async () => { for (const runtime of runtimes) await runtime.cleanup(); });

  for (const action of ["slow_accept", "slow_comment_keep", "slow_reject", "slow_comment_reject", "client_closing", "disconnect", "conflict", "no-ready"] as const) {
    await writeFile(file, "before", { mode: 0o640 });
    const script = join(dir, `${action}.lua`);
    await writeFile(script, action);
    const runtime = new BlinkRuntime({ mode: "slow", cwd: dir, ownerPane: owner, reviewScript: script, pi, queueMutation: queue, sinks, startupTimeoutMs: 150 });
    runtimes.push(runtime);
    runtime.setContext(ctx);
    const original = { content: [{ type: "text", text: "built-in-ok" }], details: { firstChangedLine: 1 } };
    const run = runtime.runSlow({
      toolName: "edit",
      toolCallId: action,
      params: { path: "a.txt" },
      signal: undefined,
      ctx,
      executeBuiltin: async () => { await writeFile(file, "after"); return original; },
    } as any);
    if (action === "slow_accept") {
      let accepted;
      try { accepted = await run; } catch (error) {
        const panes = await command("tmux", ["-L", server, "list-panes", "-a", "-F", "#{pane_id} #{pane_dead} #{pane_current_command}"]);
        const capture = await command("tmux", ["-L", server, "capture-pane", "-p", "-S", "-100"]);
        throw new Error(`${String(error)}\n${panes.stdout}\n${capture.stdout}`);
      }
      assert.strictEqual(accepted, original);
      assert.equal(await readFile(file, "utf8"), "after");
    } else if (action === "slow_comment_keep") {
      const commented = await run;
      assert.strictEqual(commented.details, original.details);
      assert.match(commented.content.at(-1).text, /human note/);
      assert.equal(await readFile(file, "utf8"), "after");
    } else if (action === "slow_reject" || action === "slow_comment_reject") {
      await assert.rejects(run, action === "slow_comment_reject" ? /human note/ : /rejected.*restored/i);
      assert.equal(await readFile(file, "utf8"), "before");
    } else if (action === "client_closing") {
      const dismissed = await run;
      assert.strictEqual(dismissed, original);
      assert.equal(await readFile(file, "utf8"), "after");
    } else if (action === "disconnect") {
      const disconnected = await run;
      assert.strictEqual(disconnected, original);
      assert.equal(await readFile(file, "utf8"), "after");
    } else if (action === "conflict") {
      await assert.rejects(run, /restoration refused.*changed/i);
      assert.equal(await readFile(file, "utf8"), "external-newer");
    } else {
      await assert.rejects(run, /did not become ready.*restored/i);
      assert.equal(await readFile(file, "utf8"), "before");
    }
    await runtime.cleanup();
  }
  const blitzScript = join(dir, "blitz.lua");
  await writeFile(blitzScript, "blitz");
  await writeFile(file, "origin");
  const blitz = new BlinkRuntime({ mode: "blitz", cwd: dir, ownerPane: owner, reviewScript: blitzScript, pi, queueMutation: queue, sinks });
  runtimes.push(blitz);
  blitz.setContext(ctx);
  const firstPreparation = await blitz.prepareMutation(file);
  await writeFile(file, "version-one");
  blitz.enqueueVersion({
    toolName: "write",
    toolCallId: "blitz-1",
    preparation: firstPreparation,
    absolutePath: file,
    bytes: Buffer.from("version-one"),
    firstChangedLine: 1,
    result: { content: [{ type: "text", text: "ok" }] },
    ctx,
  } as any);
  assert.equal(blitz.retainedCount, 0, "enqueue must return before background delivery");
  await writeFile(file, "later-working-state");
  const deadline = Date.now() + 5000;
  while (blitz.retainedCount === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(blitz.retainedCount, 1);
  const retained = (blitz as any).versions[0];
  assert.equal(await readFile(retained.snapshot.path, "utf8"), "version-one", "retained exact queued bytes");
  assert.equal(await readFile(file, "utf8"), "later-working-state", "Blitz never restores working files");
  await (blitz as any).checkpointBlitzState();
  assert.equal(blitz.retainedCount, 0, "checkpoint removes the reviewed generation");
  for (let id = 2; id <= 101; id++) {
    const preparation = await blitz.prepareMutation(file);
    await writeFile(file, `version-${id}`);
    blitz.enqueueVersion({
      toolName: "write",
      toolCallId: `blitz-${id}`,
      preparation,
      absolutePath: file,
      bytes: Buffer.from(`version-${id}`),
      firstChangedLine: 1,
      result: { content: [{ type: "text", text: "ok" }] },
      ctx,
    } as any);
  }
  const evictionDeadline = Date.now() + 10000;
  while (((blitz as any).versions.at(-1)?.versionId ?? 0) < 101 && Date.now() < evictionDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(blitz.retainedCount, 1, "same-file delivery upserts one retained version");
  assert.equal((blitz as any).versions[0].versionId, 101);
  assert.equal(await readFile((blitz as any).versions[0].originSnapshotPath, "utf8"), "later-working-state", "first post-checkpoint mutation establishes a fresh baseline");
  assert.equal((blitz as any).files.size, 1, "one logical file record survives repeated same-path edits");
  assert.equal((blitz as any).preparations.size, 0, "committed pre-state byte buffers are released");
  const retainedFile = [...(blitz as any).files.values()][0] as any;
  assert.equal("revision" in retainedFile, false, "file records retain snapshots and hashes, not complete origin buffers");
  await blitz.cleanup();

  assert.equal(aborts, 1, "Slow restoration conflict aborts the active agent once");
});
