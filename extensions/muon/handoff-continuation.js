import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { Container, SettingsList, Text } from "@earendil-works/pi-tui";
import { DynamicBorder, getSettingsListTheme } from "@earendil-works/pi-coding-agent";

const HANDOFF_MESSAGE_TYPE = "muon-handoff-context";

export function getHandoffDir(cwd) {
  return join(cwd, "docs", "handoff");
}

export function subjectFromHandoffPath(path) {
  const name = basename(path);
  return name.replace(/^handoff-/, "").replace(/\.md$/, "");
}

export function discoverHandoffs(cwd) {
  const dir = getHandoffDir(cwd);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /^handoff-.+\.md$/.test(name) && !name.endsWith(".todos.md"))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      const path = join(dir, name);
      const subject = subjectFromHandoffPath(name);
      return {
        subject,
        path,
        todoPath: join(dir, `handoff-${subject}.todos.md`),
      };
    });
}

export function parseHandoffBullets(markdown) {
  const bullets = [];
  for (const line of markdown.split(/\r?\n/)) {
    const match = line.match(/^\s*-\s+(?:`([^`]+)`|([^\s]+))\s+-\s+(.+)\s*$/);
    if (!match) continue;
    const path = (match[1] ?? match[2] ?? "").trim();
    const description = match[3].trim();
    if (!path || !description) continue;
    bullets.push({ path, description, raw: `- \`${path}\` - ${description}` });
  }
  return bullets;
}

export function parseTodoTasks(markdown) {
  const tasks = [];
  let current;
  for (const line of markdown.split(/\r?\n/)) {
    const match = line.match(/^\s*- \[( |x|X)\]\s+(T\d+)\s+(.+)\s*$/);
    if (match) {
      current = {
        id: match[2],
        title: match[3].trim(),
        done: match[1].toLowerCase() === "x",
        bodyLines: [],
      };
      tasks.push(current);
      continue;
    }
    if (current && (/^\s+\S/.test(line) || line.trim() === "")) current.bodyLines.push(line.replace(/^\s{2}/, ""));
  }
  return tasks.map((task) => ({
    ...task,
    body: task.bodyLines.join("\n").trim(),
  }));
}

function resolveContextPath(cwd, path) {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
  const cwdRoot = resolve(cwd);
  const rel = relative(cwdRoot, absolute);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return { absolute, display: rel || "." };
  return { absolute, display: path };
}

export function readSelectedFileContexts(cwd, bullets) {
  return bullets.map((bullet) => {
    const resolved = resolveContextPath(cwd, bullet.path);
    try {
      const stat = statSync(resolved.absolute);
      if (!stat.isFile()) return { ...bullet, path: resolved.display, error: "not a file" };
      return { ...bullet, path: resolved.display, content: readFileSync(resolved.absolute, "utf8") };
    } catch (error) {
      return { ...bullet, path: resolved.display, error: error instanceof Error ? error.message : String(error) };
    }
  });
}

export function buildContextMessage(subject, fileContexts) {
  return [
    `Handoff selected file context for ${subject}. Use this content directly; do not read these files again unless you need a fresh version after edits.`,
    "",
    ...fileContexts.flatMap((file) => [
      `## ${file.path}`,
      file.description ? `Description: ${file.description}` : undefined,
      file.error ? `Unable to read file: ${file.error}` : "````text",
      file.error ? undefined : file.content ?? "",
      file.error ? undefined : "````",
      "",
    ].filter((line) => line !== undefined)),
  ].join("\n");
}

export function buildSelectedTasksPrompt(tasks) {
  return [
    "Implement the selected tasks in order. Pause after each task and wait for my permission before continuing.",
    "",
    "Selected tasks:",
    ...tasks.flatMap((task, index) => {
      const body = task.body ? `\n   ${task.body.replace(/\n/g, "\n   ")}` : "";
      return [`${index + 1}. ${task.id} ${task.title}${body}`];
    }),
  ].join("\n");
}

async function selectHandoff(ctx, handoffs) {
  if (handoffs.length === 0) return undefined;
  if (handoffs.length === 1) return handoffs[0];
  const label = await ctx.ui.select("Handoff", handoffs.map((handoff) => handoff.subject));
  return handoffs.find((handoff) => handoff.subject === label);
}

async function toggleItems(ctx, title, rows, selectedLabel = "selected") {
  if (!rows.length) return [];
  const staged = new Set(rows.map((row) => row.id));
  const result = await ctx.ui.custom((tui, theme, _keybindings, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
    container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
    const settingsList = new SettingsList(
      rows.map((row) => ({
        id: row.id,
        label: row.label,
        description: row.description,
        currentValue: staged.has(row.id) ? selectedLabel : "ignored",
        values: [selectedLabel, "ignored"],
      })),
      Math.min(rows.length + 2, 15),
      getSettingsListTheme(),
      (id, value) => {
        if (value === selectedLabel) staged.add(id);
        else staged.delete(id);
      },
      () => done(Array.from(staged)),
      { enableSearch: true },
    );
    container.addChild(settingsList);
    container.addChild(new Text(theme.fg("dim", "↑↓/j/k navigate • enter toggles • esc apply"), 1, 0));
    container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
    return {
      render: (width) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data) => {
        if (data === "j" || data === "J") settingsList.handleInput?.("\x1b[B");
        else if (data === "k" || data === "K") settingsList.handleInput?.("\x1b[A");
        else settingsList.handleInput?.(data);
        tui.requestRender();
      },
    };
  });
  if (!result) return undefined;
  const selected = new Set(result);
  return rows.filter((row) => selected.has(row.id)).map((row) => row.value);
}

function readText(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

async function runContinuation(ctx, controlled, queueContext) {
  const handoff = await selectHandoff(ctx, discoverHandoffs(ctx.cwd));
  if (!handoff) {
    ctx.ui.notify("No docs/handoff/handoff-*.md files found.", "warning");
    return;
  }

  const contextBullets = parseHandoffBullets(readText(handoff.path));
  const tasks = parseTodoTasks(readText(handoff.todoPath));
  if (!tasks.length) {
    ctx.ui.notify(`No TODO tasks found in ${handoff.todoPath}.`, "warning");
    return;
  }

  let selectedBullets = contextBullets;
  let injectedStats = { files: 0, bytes: 0, failed: 0 };
  if (controlled) {
    selectedBullets = await toggleItems(ctx, `Handoff context: ${handoff.subject}`, contextBullets.map((bullet, index) => ({
      id: String(index),
      label: bullet.path,
      description: bullet.description,
      value: bullet,
    })));
    if (selectedBullets === undefined) return;
  }

  if (selectedBullets.length) {
    const fileContexts = readSelectedFileContexts(ctx.cwd, selectedBullets);
    injectedStats = {
      files: fileContexts.length,
      bytes: fileContexts.reduce((total, file) => total + Buffer.byteLength(file.content ?? "", "utf8"), 0),
      failed: fileContexts.filter((file) => file.error).length,
    };
    queueContext({
      content: buildContextMessage(handoff.subject, fileContexts),
      details: {
        subject: handoff.subject,
        path: handoff.path,
        files: fileContexts.map((file) => ({ path: file.path, ok: !file.error, bytes: Buffer.byteLength(file.content ?? "", "utf8"), error: file.error })),
      },
    });
  }

  const openTasks = tasks.filter((task) => !task.done);
  const selectedTasks = await toggleItems(ctx, `TODO: ${handoff.subject}`, openTasks.map((task) => ({
    id: task.id,
    label: `${task.id} ${task.title}`,
    description: task.body.replace(/\n/g, " ").slice(0, 160),
    value: task,
  })));
  if (selectedTasks === undefined) return;
  if (!selectedTasks.length) {
    ctx.ui.notify("No TODO tasks selected.", "info");
    return;
  }

  ctx.ui.setEditorText(buildSelectedTasksPrompt(selectedTasks));
  const failureNote = injectedStats.failed ? `; ${injectedStats.failed} file(s) unreadable` : "";
  ctx.ui.notify(
    `Loaded ${selectedTasks.length} task(s) from ${handoff.subject}. Queued ${injectedStats.files} file(s), ${injectedStats.bytes.toLocaleString()} bytes of content${failureNote}, for the next prompt.`,
    injectedStats.failed ? "warning" : "info",
  );
}

export default function registerHandoffContinuation(pi, isEnabled) {
  let pendingContext;
  const queueContext = (context) => {
    pendingContext = context;
  };

  pi.on("before_agent_start", () => {
    if (!pendingContext) return;
    const context = pendingContext;
    pendingContext = undefined;
    return {
      message: {
        customType: HANDOFF_MESSAGE_TYPE,
        content: context.content,
        display: false,
        details: context.details,
      },
    };
  });

  pi.registerCommand("handoff", {
    description: "Continue from a repo-local handoff TODO list",
    handler: async (_args, ctx) => {
      if (!isEnabled()) {
        ctx.ui.notify("Enable the handoff skill under /muon skills first.", "warning");
        return;
      }
      await runContinuation(ctx, false, queueContext);
    },
  });

  pi.registerCommand("hcon", {
    description: "Continue from handoff with file-context selection",
    handler: async (_args, ctx) => {
      if (!isEnabled()) {
        ctx.ui.notify("Enable the handoff skill under /muon skills first.", "warning");
        return;
      }
      await runContinuation(ctx, true, queueContext);
    },
  });
}
