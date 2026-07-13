import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AsyncMutex, createBlinkToolDefinitions } from "../tools.ts";

type Result = { content: Array<{ type: "text"; text: string }>; details?: unknown };

function fakeDefinition(name: "edit" | "write", calls: Array<{ cwd: string; params: any }>, options?: any) {
  const renderer = () => ({ render: () => [], invalidate() {} });
  return {
    name,
    label: name,
    description: `${name} description`,
    promptSnippet: `${name} snippet`,
    promptGuidelines: [`${name} guideline`],
    parameters: { kind: `${name}-schema` },
    prepareArguments: (args: unknown) => args,
    renderShell: "self",
    renderCall: renderer,
    renderResult: renderer,
    async execute(_id: string, params: any): Promise<Result> {
      calls.push({ cwd: options?.cwd ?? "", params });
      if (name === "edit" && options?.operations) {
        const absolute = join(options.cwd, params.path);
        const current = await options.operations.readFile(absolute);
        await options.operations.writeFile(absolute, `${current.toString("utf8")}!`);
      }
      return { content: [{ type: "text", text: "ok" }], details: { exact: true } };
    },
  };
}

function harness(mode: "off" | "slow" | "blitz", calls: Array<any>) {
  const origins = new Map<string, Promise<Buffer | "absent">>();
  const versions: Array<{ path: string; bytes: Buffer }> = [];
  const slowEntries: string[] = [];
  const defs = createBlinkToolDefinitions({
    initialCwd: "/initial",
    getMode: () => mode,
    createEditDefinition(cwd, options) {
      return fakeDefinition("edit", calls, { cwd, ...options });
    },
    createWriteDefinition(cwd) {
      return fakeDefinition("write", calls, { cwd });
    },
    async runSlow(input) {
      slowEntries.push(`start:${input.toolName}`);
      const result = await input.executeBuiltin();
      await new Promise((resolve) => setTimeout(resolve, 15));
      slowEntries.push(`end:${input.toolName}`);
      return result;
    },
    captureBlitzOrigin(path, readOrigin) {
      let promise = origins.get(path);
      if (!promise) {
        promise = readOrigin();
        origins.set(path, promise);
      }
      return promise;
    },
    enqueueBlitzVersion(input) {
      versions.push({ path: input.absolutePath, bytes: Buffer.from(input.bytes) });
    },
  });
  return { defs, origins, versions, slowEntries };
}

const ctx = (cwd: string) => ({ cwd });

test("definitions preserve every built-in metadata and renderer slot", () => {
  const calls: any[] = [];
  const { defs } = harness("off", calls);
  for (const definition of [defs.edit, defs.write]) {
    assert.equal(definition.description, `${definition.name} description`);
    assert.equal(definition.promptSnippet, `${definition.name} snippet`);
    assert.deepEqual(definition.promptGuidelines, [`${definition.name} guideline`]);
    assert.equal((definition.parameters as any).kind, `${definition.name}-schema`);
    assert.equal(typeof definition.prepareArguments, "function");
    assert.equal(typeof definition.renderCall, "function");
    assert.equal(typeof definition.renderResult, "function");
    assert.equal(definition.renderShell, "self");
  }
});

test("Off delegates once using the execution context cwd and exact result", async () => {
  const calls: any[] = [];
  const { defs } = harness("off", calls);
  const result = await defs.write.execute("w1", { path: "a", content: "x" }, undefined, undefined, ctx("/current") as any);
  assert.deepEqual(result, { content: [{ type: "text", text: "ok" }], details: { exact: true } });
  assert.deepEqual(calls, [{ cwd: "/current", params: { path: "a", content: "x" } }]);
});

test("Slow routes edit and write through one global lifecycle mutex", async () => {
  const calls: any[] = [];
  const { defs, slowEntries } = harness("slow", calls);
  await Promise.all([
    defs.write.execute("w", { path: "a", content: "x" }, undefined, undefined, ctx("/cwd") as any),
    defs.write.execute("w2", { path: "b", content: "y" }, undefined, undefined, ctx("/cwd") as any),
  ]);
  assert.deepEqual(slowEntries, ["start:write", "end:write", "start:write", "end:write"]);
});

test("Blitz write captures immutable exact UTF-8 parameter bytes and returns before delivery", async () => {
  const calls: any[] = [];
  const { defs, versions } = harness("blitz", calls);
  const result = await defs.write.execute("w", { path: "new.txt", content: "a\r\nβ" }, undefined, undefined, ctx("/cwd") as any);
  assert.equal(result.content[0].text, "ok");
  assert.equal(versions[0].bytes.toString("utf8"), "a\r\nβ");
});

test("Blitz edit captures bytes passed to writeFile, not a later reread", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "blink-tools-"));
  t.after(async () => { await import("node:fs/promises").then(({ rm }) => rm(dir, { recursive: true, force: true })); });
  const file = join(dir, "a.txt");
  await writeFile(file, "one");
  const calls: any[] = [];
  const { defs, versions } = harness("blitz", calls);
  await defs.edit.execute("e", { path: "a.txt", edits: [] }, undefined, undefined, ctx(dir) as any);
  await writeFile(file, "later");
  assert.equal(versions[0].bytes.toString("utf8"), "one!");
  assert.equal(await readFile(file, "utf8"), "later");
});

test("AsyncMutex releases after failures", async () => {
  const mutex = new AsyncMutex();
  await assert.rejects(mutex.run(async () => { throw new Error("boom"); }), /boom/);
  assert.equal(await mutex.run(async () => 42), 42);
});
