# Blink implementation specification

Status: **frozen for implementation**  
Date frozen: **2026-07-13**

Blink replaces the plan-document-oriented `plan-mode` extension with a human-in-the-loop file review extension for Pi, tmux, and Neovim.

## Product summary

| Mode | Contract |
|---|---|
| **Off** | Pi behaves normally. |
| **Slow** | Every successful built-in `edit` or `write` waits for human acceptance, rejection, or feedback before its tool result completes. |
| **Blitz** | Every successful built-in `edit` or `write` adds a read-only cumulative review version without waiting for the human. Blitz can comment, submit TODO feedback, dismiss its pane, or abort the agent; it cannot accept, reject, or restore files. |

Frozen shared decisions:

- `/blink` uses a Vim-style Pi picker: `j/k` move, `l/Enter` select, `h/Escape` cancel.
- The selected mode is session state; a running agent captures one mode for its entire run.
- `/blink` refuses mode changes while `ctx.isIdle()` is false.
- A new session and a fork start Off. Reload restores the selected mode but discards review history.
- Resume restores the selected mode recorded in the resumed session.
- Blink reviews only regular text files up to **15 MiB** changed by built-in `edit` and `write`.
- Bash, binary, symlink, and third-party custom-tool mutations are outside the automatic review boundary.
- Pi owns all Slow restoration. Neovim never mutates working files.
- Blink uses the user's normal Neovim configuration with a bundled, self-contained Blink client.
- Blink does not modify the user's tmux or Neovim configuration.

## Specification reading order

An implementation agent must read these files completely in order:

1. [blink.md](blink.md) — common extension scaffolding, mode state, wrappers, tmux/Neovim lifecycle, and feedback sinks.
2. [diff-model.md](diff-model.md) — immutable origins, cumulative Blitz versions, Slow diffs, and rendering rules.
3. [slow.md](slow.md) — blocking review, restoration, cancellation, and conflicts.
4. [blitz.md](blitz.md) — exact version capture, background delivery, history limits, navigation, comments, and abort.
5. [protocol.md](protocol.md) — private Unix socket, JSONL messages, validation, and cleanup.
6. [testing.md](testing.md) — test-first implementation gates, component tests, smoke tests, and QA prompt.

If implementation reveals a contradiction, update the relevant specification and record the decision before changing behavior.

## Required repository reading

Before implementation, read:

- `/home/tlam/Pi-Package/AGENTS.md`
- `/home/tlam/Pi-Package/package.json`
- `/home/tlam/Pi-Package/README.md`
- `/home/tlam/Pi-Package/manual.md`
- `extensions/plan-mode/index.ts`
- `extensions/plan-mode/editor.ts`
- `extensions/plan-mode/ui-picker.ts`
- `extensions/plan-mode/state.ts`
- `extensions/plan-mode/types.ts`

The current plan-mode code is reference material only. Reuse its picker, persistence, status, and `execFile` patterns; do not evolve its domain state into Blink.

## Required Pi documentation

Resolve the installed `@earendil-works/pi-coding-agent` package first; the current planning environment used:

```text
/home/tlam/.npm/_npx/99fca8174466655b/node_modules/@earendil-works/pi-coding-agent/
```

Read these installed files completely and re-check current generated types before coding:

```text
docs/extensions.md
docs/tui.md
docs/keybindings.md
docs/tmux.md
examples/extensions/tool-override.ts
examples/extensions/built-in-tool-renderer.ts
examples/extensions/permission-gate.ts
examples/extensions/send-user-message.ts
examples/extensions/event-bus.ts
dist/core/tools/edit.d.ts
dist/core/tools/edit.js
dist/core/tools/write.d.ts
dist/core/tools/write.js
dist/core/tools/file-mutation-queue.js
dist/core/extensions/types.d.ts
```

Contracts to verify rather than assume:

- parallel tool preflight and execution order;
- `createEditToolDefinition()` and `createWriteToolDefinition()` exports;
- built-in prompt metadata, renderers, schemas, and result shapes;
- `EditToolDetails.firstChangedLine`;
- `withFileMutationQueue()` behavior;
- `tool_result` handlers being awaited;
- `pi.appendEntry()`, `pi.events`, `pi.sendUserMessage()`, `ctx.isIdle()`, `ctx.abort()`, and session event reasons.

## Local tmux and Neovim context

Inspect these live files before integration testing:

```text
/home/tlam/.config/tmux/tmux.conf
/home/tlam/.config/nvim/init.lua
/home/tlam/.config/nvim/lua/plugins/navigation.lua
/home/tlam/.config/nvim/lua/plugins/which-key.lua
/home/tlam/.config/nvim/lua/plugins/utils.lua
```

Observed at freeze time:

- tmux has `focus-events on`, `extended-keys on`, and `extended-keys-format csi-u`;
- `Ctrl-h/j/k/l` navigates tmux panes;
- `Shift-L` opens `snipe.nvim`'s normal buffer menu;
- `which-key.nvim`, Gitsigns, and `vim-tmux-navigator` are available;
- Blink buffers should be listed and uniquely named so the existing Snipe menu can show them;
- optional plugins may enhance Blink but must not be correctness dependencies.

Do not edit live configuration unless the user separately requests it.

## Test-first implementation order

| Gate | Deliverable |
|---|---|
| 1 | Pure origin, snapshot, size-limit, hash, and Slow restore logic with filesystem tests. |
| 2 | Built-in tool wrappers with fake operations; prove Off delegation, Slow serialization, and exact Blitz byte capture. |
| 3 | JSONL protocol and private runtime-directory lifecycle with fake peers. |
| 4 | Pure/headless Neovim state, cumulative diffs, read-only buffers, mappings, and eviction. |
| 5 | tmux adapter against an isolated `tmux -L` server and fake editor. |
| 6 | Slow and Blitz coordinators with fake Pi contexts, panes, clients, and sinks. |
| 7 | Component integration, then real tmux/Neovim smoke tests. |
| 8 | Remove plan-mode and update package documentation only after Blink passes. |

Do not start with a model-driven end-to-end session. Concurrency, cancellation, and restoration require deterministic tests first.

## Completion criteria

- `/blink` exposes Off, Slow, and Blitz with the frozen contracts.
- Off preserves built-in tool schemas, prompt metadata, rendering, and behavior.
- Slow safely serializes, reviews, restores, and reports cancellation/conflicts.
- Blitz captures exact versions and returns without waiting for review delivery.
- Cumulative origin-relative diffs match [diff-model.md](diff-model.md).
- History obeys 15 MiB per file, 100 retained versions, and 100 MiB per runtime limits.
- Socket and pane cleanup is idempotent on Off, reload, session switch/fork, and exit.
- Unit and component tests pass before smoke tests.
- `extensions/plan-mode/`, plan commands, prompt injection, attachment UX, and `plan_diff` are removed after replacement tests pass.
- Existing user plan files on disk are left untouched.
- `AGENTS.md`, root `README.md`, `manual.md`, and Blink documentation are updated.
