import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildContextMessage,
  buildSelectedTasksPrompt,
  discoverHandoffs,
  parseHandoffBullets,
  parseTodoTasks,
  readSelectedFileContexts,
} from "../handoff-continuation.js";

const bullets = parseHandoffBullets(`
# Handoff: demo

- \`extensions/muon/index.ts\` - registers Muon extension surfaces
- extensions/muon/handoff-continuation.js - owns continuation commands
- malformed line ignored
`);
assert.deepEqual(bullets.map((bullet) => [bullet.path, bullet.description]), [
  ["extensions/muon/index.ts", "registers Muon extension surfaces"],
  ["extensions/muon/handoff-continuation.js", "owns continuation commands"],
]);

const tasks = parseTodoTasks(`
# TODO: demo

- [ ] T001 Add command
  - Context: wire /handoff
  - Done when: editor is populated

ignored text
- [x] T002 Old task
  - Context: already done

- [ ] T003 Parse files
  extra detail
`);
assert.equal(tasks.length, 3);
assert.equal(tasks[0].id, "T001");
assert.equal(tasks[0].done, false);
assert.match(tasks[0].body, /Done when/);
assert.equal(tasks[1].done, true);
assert.match(tasks[2].body, /extra detail/);

const contextRoot = mkdtempSync(join(tmpdir(), "muon-context-"));
writeFileSync(join(contextRoot, "example.txt"), "actual file contents\n");
const fileContexts = readSelectedFileContexts(contextRoot, [{ path: "example.txt", description: "demo file" }]);
assert.equal(fileContexts[0].content, "actual file contents\n");
assert.match(buildContextMessage("demo", fileContexts), /Handoff selected file context for demo/);
assert.match(buildContextMessage("demo", fileContexts), /actual file contents/);
assert.match(buildSelectedTasksPrompt(tasks.filter((task) => !task.done)), /Pause after each task/);
assert.doesNotMatch(buildSelectedTasksPrompt([tasks[0]]), /T002/);

const root = mkdtempSync(join(tmpdir(), "muon-handoff-"));
const handoffDir = join(root, "docs", "handoff");
mkdirSync(handoffDir, { recursive: true });
writeFileSync(join(handoffDir, "handoff-demo.md"), "# Handoff: demo\n");
writeFileSync(join(handoffDir, "handoff-demo.todos.md"), "# TODO: demo\n");
writeFileSync(join(handoffDir, "notes.md"), "ignored\n");
assert.deepEqual(discoverHandoffs(root).map((handoff) => handoff.subject), ["demo"]);

console.log("muon handoff continuation checks passed");
