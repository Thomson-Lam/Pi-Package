import test from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";

import { BlinkJsonlServer, createRuntimeResources, type Envelope } from "../protocol.ts";

async function setup(t: test.TestContext) {
  const base = await mkdtemp(join(tmpdir(), "blink-protocol-base-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const resources = await createRuntimeResources(base);
  const messages: Envelope[] = [];
  let disconnects = 0;
  const server = new BlinkJsonlServer({
    socketPath: resources.socketPath,
    reviewId: "review-1",
    mode: "blitz",
    onMessage: async (message) => { messages.push(message); },
    onDisconnect: () => { disconnects++; },
  });
  await server.start();
  t.after(() => server.close());
  return { resources, server, messages, getDisconnects: () => disconnects };
}

function frame(type: string, payload: unknown = {}, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ protocolVersion: 1, type, reviewId: "review-1", payload, ...extra }) + "\n";
}

async function client(path: string) {
  const socket = connect(path);
  await once(socket, "connect");
  return socket;
}

test("runtime directory, snapshot directory, and socket are private and unique", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "blink-private-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const a = await createRuntimeResources(base);
  const b = await createRuntimeResources(base);
  assert.notEqual(a.runtimeDir, b.runtimeDir);
  assert.equal((await lstat(a.runtimeDir)).mode & 0o777, 0o700);
  assert.equal((await lstat(a.snapshotsDir)).mode & 0o777, 0o700);
  const server = new BlinkJsonlServer({ socketPath: a.socketPath, reviewId: "x", mode: "slow", onMessage: async () => {} });
  await server.start();
  assert.equal((await lstat(a.socketPath)).mode & 0o777, 0o600);
  await server.close();
});

test("parses partial frames and several frames in one chunk", async (t) => {
  const { resources, messages } = await setup(t);
  const socket = await client(resources.socketPath);
  const one = frame("client_ready", { nvimVersion: "0.12" });
  socket.write(one.slice(0, 13));
  socket.write(one.slice(13) + frame("request_state"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(messages.map((m) => m.type), ["client_ready", "request_state"]);
  socket.destroy();
});

test("rejects malformed, wrong-version, wrong-review, and oversized frames before dispatch", async (t) => {
  const { resources, messages } = await setup(t);
  for (const bad of [
    "not-json\n",
    JSON.stringify({ protocolVersion: 2, type: "client_ready", reviewId: "review-1", payload: {} }) + "\n",
    JSON.stringify({ protocolVersion: 1, type: "client_ready", reviewId: "other", payload: {} }) + "\n",
    `${"x".repeat(256 * 1024 + 1)}\n`,
  ]) {
    const socket = await client(resources.socketPath);
    socket.resume();
    const closed = once(socket, "close");
    socket.write(bad);
    await closed;
  }
  assert.equal(messages.length, 0);
});

test("allows only one active client", async (t) => {
  const { resources } = await setup(t);
  const first = await client(resources.socketPath);
  first.write(frame("client_ready"));
  const second = await client(resources.socketPath);
  const [data] = await once(second, "data") as [Buffer];
  assert.match(data.toString(), /active client/);
  await once(second, "close");
  first.destroy();
});

test("server sends validated envelopes and close is idempotent", async (t) => {
  const { resources, server } = await setup(t);
  const socket = await client(resources.socketPath);
  socket.write(frame("client_ready"));
  await new Promise((resolve) => setTimeout(resolve, 10));
  server.send("hello", { mode: "blitz" });
  const [data] = await once(socket, "data") as [Buffer];
  const sent = JSON.parse(data.toString());
  assert.equal(sent.protocolVersion, 1);
  assert.equal(sent.reviewId, "review-1");
  assert.equal(sent.type, "hello");
  await Promise.all([server.close(), server.close()]);
});

test("disconnect callback fires once for an accepted client", async (t) => {
  const { resources, getDisconnects } = await setup(t);
  const socket = await client(resources.socketPath);
  socket.write(frame("client_ready"));
  socket.destroy();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(getDisconnects(), 1);
});
