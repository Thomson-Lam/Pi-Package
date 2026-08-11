import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./helpers.mjs";

const extensionModule = await load("../src/index.ts");
const register = extensionModule.default ?? extensionModule;

test("extension registers /cnew without adding /ctx fresh", async () => {
  const commands = new Map();
  const renderers = new Map();
  const shortcuts = [];
  const pi = {
    on() {},
    registerCommand(name, options) { commands.set(name, options); },
    registerShortcut(shortcut) { shortcuts.push(shortcut); },
    registerMessageRenderer(type, renderer) { renderers.set(type, renderer); },
  };
  register(pi);
  assert.equal(commands.has("cnew"), true);
  assert.equal(commands.has("can"), true);
  assert.equal(commands.has("cana"), true);
  assert.equal(commands.has("canu"), true);
  assert.equal(commands.has("ctfresh"), false);
  assert.deepEqual(shortcuts, []);
  assert.equal(renderers.has("ctx:fresh-files"), true);
  assert.deepEqual(commands.get("ctx").getArgumentCompletions("f"), []);

  const notifications = [];
  await commands.get("cnew").handler("", { mode: "print", ui: { notify: (...args) => notifications.push(args) } });
  assert.match(notifications[0][0], /interactive TUI/);
});
