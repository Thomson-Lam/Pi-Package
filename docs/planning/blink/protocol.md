# Blink protocol and runtime-resource specification

Status: **frozen for implementation**  
Parent: [README.md](README.md)

Blink uses newline-delimited JSON over one local Unix-domain socket. It is a personal local integration, not a cross-user security service.

## Private runtime directory

Create one random directory per active Blink runtime:

```text
${XDG_RUNTIME_DIR:-<os.tmpdir()>}/pi-blink-XXXXXX/
├── blink.sock
└── snapshots/
```

- Create with `mkdtemp()`.
- Directory mode: `0700`.
- Snapshot directory mode: `0700`.
- Snapshot mode: `0600`.
- Socket mode after listen: `0600`.
- Use opaque snapshot filenames.
- Keep canonical working paths only in Pi-owned in-memory state; display paths may be sent to Neovim.
- Do not use a separate capability token.
- Never reuse or unlink an unknown socket path at startup; every runtime gets a new random directory.

A hard process kill may leave an inert socket file, but cannot leave a live server after Pi exits. `$XDG_RUNTIME_DIR` or normal temporary-directory cleanup handles abandoned files; v1 does not scan arbitrary old directories.

## Launch environment

Pass values explicitly to the Neovim pane process:

```text
BLINK_REVIEW_ID
BLINK_SOCKET_PATH
BLINK_MODE
BLINK_CWD
BLINK_PROTOCOL_VERSION=1
```

Do not interpolate these values into Ex commands. `review.lua` reads the environment and validates required values before connecting.

## Envelope

```ts
interface Envelope<T = unknown> {
  protocolVersion: 1;
  type: string;
  reviewId: string;
  requestId?: string;
  payload: T;
}
```

- One JSON object per newline.
- Maximum frame size: **256 KiB**; file content is transferred through private snapshot paths, not JSON.
- Handle partial frames and several frames in one socket chunk.
- Reject malformed JSON, wrong protocol version, wrong review ID, missing required fields, and oversized frames.
- Use the already-installed `zod` dependency or small explicit validation; add no new protocol dependency.
- One active client per runtime. A second connection is rejected until the first closes.

## Identity and path trust

Opaque IDs:

- `reviewId`: current runtime;
- `transactionId`: one Slow review;
- `fileId`: one canonical path inside a Blitz runtime;
- `versionId`: one retained Blitz version;
- `requestId`: one client action.

Neovim actions send IDs, never an authoritative working path. Pi resolves IDs against current runtime state. Snapshot paths in server messages are read-only display inputs and must resolve under the current private runtime directory.

## Connection sequence

```text
Neovim connects
  → client_ready
Pi validates runtime/mode/client
  → hello
Neovim requests current state
  → request_state
Pi sends Slow transaction or retained Blitz timeline
  → state_snapshot
```

The server discloses no state before a valid `client_ready` for the current review ID and protocol.

### Slow

- Only one connection and one pending transaction exist.
- `client_ready` must arrive within 5 seconds of pane launch.
- Explicit `client_closing` before terminal disposition dismisses the Slow UI, keeps the post-state, and resolves the tool with its original result.
- Socket disconnect without prior `client_closing` before terminal disposition means cancellation/reject.
- Slow does not reconnect after disconnect; the transaction resolves through dismissal or cancellation.

### Blitz

- A client may disconnect by dismissing the pane.
- Server and history remain alive.
- No immediate reconnect loop is required.
- The next retained version respawns a pane/client.
- The new client receives a full retained `state_snapshot`.

## Server-to-client messages

| Type | Mode | Purpose |
|---|---|---|
| `hello` | both | Confirm protocol, mode, review ID, cwd, and available sinks |
| `state_snapshot` | both | Replace client state from current Slow transaction or retained Blitz history |
| `slow_action_result` | Slow | Acknowledge or reject accept/reject/comment/TODO request |
| `version_added` | Blitz | Add one retained version and origin reference |
| `version_evicted` | Blitz | Close one evicted version buffer |
| `sink_list_changed` | both | Replace available sink metadata |
| `feedback_result` | both | Acknowledge or reject feedback submission |
| `agent_abort_requested` | Blitz | Confirm `ctx.abort()` request |
| `agent_abort_unavailable` | Blitz | Pi is idle/no current agent |
| `mode_changed` | both | Inform client before intentional mode cleanup when useful |
| `shutdown` | both | Client must close without sending a filesystem action |
| `error` | both | Structured protocol/action error |

Snapshot payloads include opaque IDs, display path, snapshot path, size, location, and mode-specific status. They never include an arbitrary action target path.

## Client-to-server messages

| Type | Mode | Purpose |
|---|---|---|
| `client_ready` | both | Announce protocol/Neovim versions and requested review ID |
| `request_state` | both | Request authoritative replay |
| `slow_accept` | Slow | Accept current transaction |
| `slow_reject` | Slow | Reject current transaction |
| `slow_comment_keep` | Slow | Keep and attach agent feedback to result |
| `slow_comment_reject` | Slow | Reject and attach feedback |
| `submit_todo` | both | Submit comment to sink without disposition |
| `submit_agent_feedback` | Blitz | Send steering feedback for a retained version/range |
| `abort_agent` | Blitz | Confirmed request for `ctx.abort()` |
| `client_closing` | both | Dismiss UI without disabling mode; Slow keeps the reviewed change |

There are no Blitz accept/reject messages.

## Request handling

- Every action has a `requestId`.
- Retain a bounded set of recent request IDs for the runtime.
- Duplicate Slow terminal actions return the original acknowledgement or “already resolved”; they never act twice.
- Duplicate abort requests call `ctx.abort()` at most once.
- Duplicate TODO/comment requests must not submit twice.
- Unknown message types return `error` without crashing the connection.
- Validate action availability by mode and current IDs.

## Snapshot reads

Neovim receives snapshot paths because it runs as the same local user.

Before reading, the client should ensure the path was supplied by the server; it must not construct paths from working filenames. If a snapshot disappears due to eviction, close the matching buffer or request a fresh state snapshot.

## Idempotent cleanup

Cleanup order:

1. mark runtime closing and reject new actions/connections;
2. stop/cancel queued Blitz work;
3. settle pending Slow transaction through its cancellation contract;
4. send `shutdown` when a client is writable;
5. destroy the client socket;
6. close the server with a short bounded wait;
7. focus owner and kill only the verified review pane;
8. remove the socket, snapshots, and runtime directory recursively;
9. clear all handles and recent request IDs.

Register cleanup once and make repeated calls return the same promise or harmlessly no-op.

## Required tests

1. Runtime directory and files receive restrictive modes.
2. Two runtimes receive different short socket paths.
3. Partial JSONL frame.
4. Multiple frames in one chunk.
5. Malformed and oversized frame rejection.
6. Wrong protocol/review ID rejection before state disclosure.
7. Second active client rejected.
8. Duplicate terminal/abort/TODO requests are idempotent.
9. Unknown message returns structured error.
10. Slow disconnect triggers cancellation exactly once.
11. Blitz disconnect preserves server state.
12. New Blitz client receives complete retained snapshot.
13. Snapshot path outside runtime directory is rejected client-side/server-side as applicable.
14. Cleanup with no client, active client, already-dead pane, and repeated calls.
15. No unhandled errors when files/socket have already disappeared.

## Acceptance criteria

- No predictable or reused socket path is needed.
- No separate auth handshake exists.
- Malformed clients cannot choose working-file mutation targets.
- Slow disconnect cannot be mistaken for acceptance.
- Blitz dismissal cannot disable mode or delete history.
- Normal and repeated shutdown leave no live server or verified pane.
