# Blink Blitz mode specification

Status: **frozen for implementation**  
Parent: [README.md](README.md)

Blitz is a non-blocking, read-only timeline of exact built-in `edit` and `write` results.

## Explicit non-features

Blitz has no:

- accept action;
- reject action;
- filesystem restore;
- accepted baseline;
- accept/reject-all action;
- compare-and-swap mutation;
- persistent recovery manifest.

The user may inspect versions, comment to the agent, submit TODO feedback, dismiss the pane, or confirm agent abort.

## Timeline model

```ts
interface BlitzFileHistory {
  fileId: string;
  path: string;
  origin: Snapshot | "absent";
  versions: BlitzVersion[];
}

interface BlitzVersion {
  versionId: number;
  fileId: string;
  snapshot: Snapshot;
  byteLength: number;
  toolCallId: string;
  firstChangedLine: number;
  createdAt: number;
  unread: boolean;
}
```

- `versionId` is monotonically increasing across the runtime.
- The origin is captured once before the first observed mutation of a path and never advances.
- Every version diffs against that origin as specified in [diff-model.md](diff-model.md).
- Version IDs provide ordering and feedback provenance only; they are not restoration generations.

## Exact capture without review blocking

Blitz must not reread the working file later to discover a version; a later mutation may already have changed it.

### `write`

- Capture the immutable origin before the first mutation of that path.
- The exact post-state is `params.content` encoded as the built-in writes it.
- Delegate to Pi's built-in write definition.
- On success, synchronously assign a version ID and enqueue the captured bytes.
- Return the original result without waiting for snapshot disk writes, IPC, tmux, or Neovim.

### `edit`

Use the built-in edit definition with wrapped `EditOperations`:

- `readFile` delegates to Node filesystem operations and participates in origin capture;
- `access` delegates unchanged;
- `writeFile` delegates the exact built-in output and retains those exact bytes in memory.

After successful built-in execution, synchronously assign a version ID, enqueue the retained bytes, and return the original result.

This wraps exported Pi APIs; it does not patch installed Pi source.

### Concurrent first mutations

Origin creation is an idempotent promise stored by canonical path before its first await. Parallel sibling wrappers for the same path await the same origin capture. The built-in per-file queue still determines mutation order.

## Background delivery queue

One ordered queue belongs to the Blitz runtime. Each job already contains immutable captured bytes.

For each job:

1. Re-check runtime identity; discard work for a closed runtime.
2. Validate text and 15 MiB post-state limit.
3. Persist the origin once and the version snapshot with mode `0600`.
4. Apply history eviction if needed.
5. Start the socket server if absent.
6. Ensure the exact review pane exists; create and focus it when absent.
7. Publish the version and any evictions, or retain them for `state_snapshot` replay.
8. Catch and surface failures without rejecting an already returned Pi tool result.

The queue may perform jobs sequentially because it does not block agent tools. Do not create per-version workers or detached untracked promises.

## Delivery failures

| Failure | Behavior |
|---|---|
| Snapshot write | Drop that version, remove partial file, notify Pi |
| tmux split failure | Keep retained state; notify; retry on next version |
| Neovim missing/exits | Keep retained state; notify; next version may respawn |
| Socket/client absent | Keep retained state for later snapshot replay |
| Unsupported content | Skip version and notify; working mutation remains |
| Runtime closed before job | Discard job silently |

A Blitz review failure never changes or rolls back the working file.

## History lifetime and limits

History lives until:

- `/blink off`;
- reload;
- session switch, new session, or fork;
- Pi exit/session shutdown.

Limits per Blink runtime:

| Limit | Value |
|---|---:|
| Individual origin or version | **15 MiB** |
| Retained versions | **100 total across all files** |
| Retained snapshot bytes | **100 MiB**, including origins |

After adding a version, evict oldest versions until both runtime limits hold.

Eviction rules:

1. Evict by global `versionId`, oldest first.
2. Pinning affects navigation only and does not exempt a version from the safety limit.
3. Send `version_evicted` so Neovim closes that buffer.
4. When no retained versions reference a file history, remove its origin snapshot and history entry.
5. Notify once per eviction pass with the number of removed versions.
6. If one origin/version cannot fit the 15 MiB individual limit, do not retain it.

## Pane and focus behavior

| Situation | Behavior |
|---|---|
| First retained version | Create and focus review pane |
| Pane dismissed, later version arrives | Recreate and focus review pane |
| Existing pane is active and unpinned | Auto-follow newest version |
| Existing pane is active and pinned | Keep current buffer; mark new version unread |
| Existing pane is not active | Never steal focus; mark new version unread |
| No retained versions | Show waiting buffer |

`<leader>bq` sends `client_closing` and exits the review pane. It does not abort Pi, disable Blitz, or clear server-side history. The next retained version respawns the pane; the new client receives all retained state.

## Version buffers

Each version is a listed scratch buffer with a unique name:

```text
blink://<display-path>@<versionId>
```

- Multiple versions of one file coexist.
- Existing `Shift-L` Snipe behavior can list them because `buflisted=true`.
- `[f`/`]f` navigate retained versions chronologically with wraparound.
- `[c`/`]c` navigate origin-relative hunks within the active version.
- Pin state is client-local and defaults false.
- When an evicted active buffer closes, activate the nearest remaining version or waiting buffer.

## Mappings

| Key | Action |
|---|---|
| `]f` / `[f` | Next/previous retained version |
| `]c` / `[c` | Next/previous hunk |
| `<leader>bc` | Submit agent feedback for active version/range |
| `<leader>bt` | Submit TODO feedback to a registered sink |
| `<leader>bp` | Toggle pin/auto-follow |
| `<leader>bx` | Confirm, then request `ctx.abort()` |
| `<leader>bq` | Dismiss review pane only |
| `?` | Help |

There are no accept/reject mappings in Blitz.

## Agent feedback

Agent comments include path, version ID, optional hunk range, and comment.

- If Pi is running, call `pi.sendUserMessage(text, { deliverAs: "steer" })`.
- If Pi is idle, send one normal user message, which starts a turn.
- Empty comments cancel locally.
- TODO feedback uses the sink interface and never enters model context.
- A comment does not mark or remove a version.

## Abort

`<leader>bx` requires Neovim confirmation.

1. Send one `abort_agent` request with request ID.
2. Validate current review/runtime and active client.
3. If `ctx.isIdle()`, reply `agent_abort_unavailable`.
4. Otherwise call the current runtime context's `ctx.abort()` once.
5. Reply `agent_abort_requested`.
6. Keep pane, history, and buffers unchanged.

Abort stops future agent work; it does not change files or clear versions.

## Required tests

1. Tool result returns before an intentionally blocked background job completes.
2. `write` captures exact parameter bytes.
3. Wrapped edit operations capture exact post bytes even when a later edit begins.
4. Parallel first mutations share one immutable origin.
5. Same-file versions receive ordered IDs and separate buffers.
6. Existing-file versions always diff against the original origin.
7. New-file versions always render against absent origin.
8. First version creates/focuses one pane; later updates reuse it.
9. Inactive existing pane receives unread updates without focus theft.
10. Dismissal preserves server history and next version respawns/focuses.
11. Snapshot/socket/tmux failures never reject returned tool results.
12. 101st version evicts the oldest.
13. Crossing 100 MiB evicts oldest versions and unreferenced origins.
14. A 15 MiB file is accepted; one byte over is skipped.
15. Eviction closes matching Neovim buffer only.
16. Agent comment routes as steer while running and normal message while idle.
17. TODO never calls the model.
18. Confirmed abort calls `ctx.abort()` once; idle abort reports unavailable.
19. Off/reload/session shutdown discards queued work and removes history.

## Acceptance criteria

- No review infrastructure wait is added after a successful Blitz mutation is enqueued.
- Every retained version contains the exact bytes produced by its tool call.
- Blitz never modifies a working file.
- Multiple versions of one path remain independently navigable until eviction/cleanup.
- History and focus behavior match this specification.
- Every background failure is caught and user-visible when still relevant.
