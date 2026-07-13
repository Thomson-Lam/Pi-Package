# Blink base extension specification

Status: **frozen for implementation**  
Parent: [README.md](README.md)

This document specifies common Pi extension wiring shared by Off, Slow, and Blitz.

## Minimal implementation layout

Start with this layout; split files only when a real boundary becomes unwieldy.

```text
extensions/blink/
├── index.ts              # registration, session lifecycle, command, status
├── tools.ts              # built-in edit/write wrappers and mode routing
├── revisions.ts          # snapshots, eligibility, hashes, Slow restore
├── runtime.ts            # Slow/Blitz runtime state and background queue
├── protocol.ts           # Unix socket server and JSONL validation
├── tmux.ts               # exact pane creation/focus/verification/cleanup
├── nvim/
│   ├── review.lua        # startup bootstrap
│   └── lua/blink/
│       ├── protocol.lua  # JSONL client
│       ├── state.lua     # review state transitions
│       └── ui.lua        # buffers, diffs, mappings, prompts
└── tests/
```

Do not add separate constants, types, sinks, picker, feedback, or coordinator files until their current owner genuinely becomes too large.

## Mode state

```ts
type BlinkMode = "off" | "slow" | "blitz";

interface BlinkState {
  selectedMode: BlinkMode;
  activeRunMode?: BlinkMode;
  runtime?: BlinkRuntime;
}
```

- `selectedMode` is the idle/session setting shown by `/blink`.
- `activeRunMode` is captured once for a running agent and governs every tool in that run.
- Review history and runtime resources are in memory plus a private temporary directory; they are not session entries.

### Session persistence

Persist only mode transitions using `pi.appendEntry("blink-mode", { mode })`.

| Session event | Mode behavior | Runtime/history behavior |
|---|---|---|
| startup | Restore latest valid mode from the active branch, default Off | Start empty |
| reload | Restore current session mode | Close and discard old runtime |
| new | Force and persist Off | Close and discard old runtime |
| resume | Restore mode from resumed session's active branch | Close old runtime; start empty |
| fork | Force and persist Off | Close and discard old runtime |
| shutdown/exit | No new state needed | Close and discard runtime |

Use `ctx.sessionManager.getBranch()` rather than selecting an entry from an abandoned branch.

## `/blink` command

The command requires Pi TUI mode.

Picker contract:

| Key | Action |
|---|---|
| `j` / `k` | Move |
| `l` / `Enter` | Select |
| `h` / `Escape` | Cancel |

- Show Off, Slow, and Blitz.
- Highlight the selected mode with `theme.fg("accent", ...)`.
- Off has no footer status.
- Slow shows accent `blink:slow`.
- Blitz shows accent `blink:blitz <retained-count>`.
- If `ctx.isIdle()` is false, refuse the command without changing state.
- Before enabling Slow or Blitz, require `ctx.mode === "tui"`, `TMUX`, `TMUX_PANE`, `tmux`, and `nvim`.
- If any requirement fails, report the concrete failure and retain the previous mode.
- Selecting Off performs idempotent runtime cleanup and keeps working-file changes.

## Run-mode lock

- On the first `agent_start` before `agent_settled`, set `activeRunMode = selectedMode`.
- Automatic retries, compaction retries, and queued continuations keep that value.
- On `agent_settled`, clear `activeRunMode` but do not clear Blitz history.
- Tool wrappers route by `activeRunMode ?? selectedMode` so direct idle tool harnesses remain testable.
- `/blink` cannot change `selectedMode` while Pi is busy.

## Built-in tool wrappers

Register one `edit` override and one `write` override at extension load.

Use Pi's exported `createEditToolDefinition()` and `createWriteToolDefinition()` as the source definitions. Spread each complete definition and replace only `execute()` so Blink preserves:

- name and label;
- parameter schema and argument preparation;
- description, prompt snippet, and prompt guidelines;
- `renderShell`, `renderCall`, and `renderResult`;
- result content and `details` shape.

Create/delegate the underlying definition using the execution context's `ctx.cwd`; do not capture a stale startup cwd. Never edit Pi's installed source.

### Routing

| Captured mode | Wrapper behavior |
|---|---|
| Off | Delegate directly to the current built-in definition. |
| Slow | Execute the lifecycle in [slow.md](slow.md) behind one global mutex. |
| Blitz | Capture exact pre/post bytes, enqueue a version event, and return the original result as specified in [blitz.md](blitz.md). |

Built-in per-file mutation queues remain in force. Blink's Slow mutex wraps the whole built-in execution and review; Blitz's queue handles review delivery, not working-file mutation.

## File eligibility

Normalize a leading `@`, resolve against `ctx.cwd`, and use `lstat()` before following anything.

Eligible files are:

- built-in `edit` or `write` targets;
- regular files, or absent paths being created by `write`;
- text bytes without NUL;
- at most `15 * 1024 * 1024` bytes for both origin and resulting version.

Unsupported handling:

| Mode | Behavior |
|---|---|
| Slow | Fail before mutation when known; if only the post-state is unsupported, safely restore and fail. |
| Blitz | Allow the built-in mutation, skip the review version, and notify the user. |

Symlinks, directories, devices, binary content, and oversized files are unsupported. Bash and custom-tool mutations are ignored.

## tmux pane adapter

Capture the owner pane from the Pi process's `TMUX_PANE` before any focus change.

Pane metadata:

```text
@blink_role       review
@blink_owner      %<owner-pane-id>
@blink_review_id  <review-id>
```

Rules:

- target exact pane IDs, never current focus or pane indexes;
- create a right split with `split-window -d -h -t <owner-pane>`;
- set cwd explicitly;
- launch Neovim with `exec nvim -S <review.lua>` and Blink environment values;
- capture the pane ID with `-P -F '#{pane_id}'`;
- set and verify Blink metadata before later focus/kill operations;
- explicitly focus every newly created or respawned review pane;
- do not call `select-pane` for ordinary updates while the pane already exists;
- before intentional cleanup, focus the verified owner and kill only the verified Blink pane;
- use argument arrays through `pi.exec()` or `execFile()`; isolate the unavoidable pane command string and test quoting.

One Blink runtime owns at most one review pane. A manually closed Blitz pane does not disable Blitz; the next version creates and focuses a replacement.

## Neovim client

Launch the user's normal Neovim configuration and source Blink's bundled bootstrap.

- Do not edit `/home/tlam/.config/nvim`.
- Blink correctness must not depend on Snipe, which-key, Gitsigns, or vim-tmux-navigator.
- Add `desc` to buffer-local mappings so which-key can display them.
- Set Blink version buffers `buflisted=true` with unique names so the existing Snipe menu can list them.
- Disable/detach misleading Gitsigns decoration in Blink buffers when available.
- Use `$TMUX_PANE` plus `tmux display-message -p -t ... '#{pane_active}'` when an update needs exact pane-focus state; `FocusGained`/`FocusLost` may optimize but not replace the query.

Buffer and diff details are frozen in [diff-model.md](diff-model.md).

## Feedback sinks

Keep a minimal registration API because a TODO sink is the next planned consumer.

```ts
interface BlinkFeedback {
  schemaVersion: 1;
  reviewId: string;
  mode: "slow" | "blitz";
  path: string;
  versionId?: number;
  range?: { startLine: number; endLine: number };
  comment: string;
  createdAt: number;
}

interface BlinkFeedbackSink {
  id: string;
  label: string;
  submit(item: BlinkFeedback): Promise<void>;
}
```

Event bus surface:

```text
blink:sink:register
blink:sink:unregister
blink:sinks:discover
```

- Registration passes the sink object, including its asynchronous callback.
- Discover on session start so extension load order does not matter.
- If one sink exists, use it by default.
- If several exist, Neovim uses `vim.ui.select()`.
- If none exists or submission fails, return an action error and keep the review state unchanged.
- TODO feedback never enters model context.
- Do not add review lifecycle events until a consumer requires them.

## Cleanup

Cleanup is idempotent and runs on:

- `/blink off`;
- reload;
- new/resume/fork session shutdown;
- process exit/session shutdown.

Order:

1. stop accepting background work and IPC actions;
2. cancel pending Slow waits safely according to [slow.md](slow.md);
3. send `shutdown` to a connected client;
4. destroy client and close socket server;
5. focus owner and close only the verified Blink pane;
6. remove snapshots, socket, and private runtime directory;
7. clear timers, queues, maps, context references, and runtime IDs.

Do not await irrelevant Blitz queue work during cleanup because its history is being discarded. Catch every detached task rejection.

## Base acceptance criteria

- Off is behaviorally compatible with current built-ins.
- Mode changes cannot split one agent run across modes.
- New/fork sessions start Off; reload/resume behavior matches the table above.
- Unsupported files follow mode-specific policy.
- No tmux command targets an unverified pane.
- Normal Neovim plugins are optional enhancements only.
- Feedback sink failures cannot silently become agent feedback.
- Repeated cleanup leaves no live pane, server, timers, or stale runtime references.
