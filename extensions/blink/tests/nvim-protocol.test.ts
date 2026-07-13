import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";

const reviewScript = resolve("extensions/blink/nvim/review.lua");

test("real headless Neovim performs Blink handshake, state replay, and shutdown", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "blink-nvim-protocol-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const socketPath = join(dir, "blink.sock");
  const snapshots = join(dir, "snapshots");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(snapshots));
  const origin = join(snapshots, "origin");
  const version = join(snapshots, "version");
  await writeFile(origin, "before\n");
  await writeFile(version, "after\n");
  const seen: string[] = [];
  const reviewId = "nvim-integration";
  let serverSocket: import("node:net").Socket | undefined;
  const server = createServer((socket) => {
    serverSocket = socket;
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const at = buffer.indexOf("\n");
        const message = JSON.parse(buffer.slice(0, at));
        buffer = buffer.slice(at + 1);
        seen.push(message.type);
        const send = (type: string, payload: any) => socket.write(`${JSON.stringify({ protocolVersion: 1, type, reviewId, payload })}\n`);
        if (message.type === "client_ready") send("hello", { mode: "slow", cwd: dir, sinks: [] });
        if (message.type === "request_state") {
          send("state_snapshot", { mode: "slow", transaction: {
            transactionId: "tx",
            displayPath: "a.txt",
            snapshotPath: version,
            originKind: "file",
            originSnapshotPath: origin,
            firstChangedLine: 1,
          } });
          setTimeout(() => send("shutdown", {}), 50);
        }
      }
    });
  });
  server.listen(socketPath);
  await once(server, "listening");
  t.after(() => new Promise<void>((resolveClose) => server.close(() => resolveClose())));

  const child = spawn("nvim", ["--headless", "-u", "NONE", "-S", reviewScript], {
    env: {
      ...process.env,
      BLINK_REVIEW_ID: reviewId,
      BLINK_SOCKET_PATH: socketPath,
      BLINK_MODE: "slow",
      BLINK_CWD: dir,
      BLINK_PROTOCOL_VERSION: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const [code] = await once(child, "exit") as [number];
  assert.equal(code, 0, stderr);
  assert.deepEqual(seen.slice(0, 2), ["client_ready", "request_state"]);
  serverSocket?.destroy();
});
