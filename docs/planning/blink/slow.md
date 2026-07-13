# Blink Slow mode specification

Status: **frozen for implementation**  
Parent: [README.md](README.md)

Slow is a blocking decision gate around every successful built-in `edit` or `write`.

## Contract

```text
acquire global Slow mutex
capture exact pre-state
execute Pi's original built-in tool
capture/hash exact post-state
open and focus review pane
wait for human action or cancellation
resolve filesystem and feedback action
focus owner and close review pane
return result or throw error
release mutex
```

The mutex covers both `edit` and `write` globally. No second wrapped mutation may modify any file until the current review resolves.

## Revision state

Slow needs one transaction, not long-lived version history.

```ts
interface SlowTransaction {
  transactionId: string;
  toolCallId: string;
  path: string;
  pre: Snapshot | "absent";
  post: Snapshot;
  preMode?: number;
  postHash: string;
  firstChangedLine: number;
}
```

- Hash raw bytes.
- Existing files preserve their pre-mutation permission mode on restore.
- New files use `pre: "absent"`.
- Snapshot files are private `0600` files in the current Blink runtime directory.
- Resolve all client actions by transaction ID; never trust a client path.

## Tool execution

Under the Slow mutex:

1. Check abort signal and eligibility.
2. Capture exact pre-state immediately before calling the built-in.
3. Delegate to the current `ctx.cwd` built-in definition.
4. If the built-in throws or reports failure, do not open review; propagate its failure.
5. Capture exact post-state and hash.
6. If the post-state is binary, non-regular, or over 15 MiB, compare-and-swap restore the pre-state and throw an unsupported-file error.
7. Write private snapshots and open the review.

Use `EditToolDetails.firstChangedLine` when available. For `write`, new files start at line 1 and existing files use the first hunk calculated by Neovim.

## Human actions

| Action | File result | Pi tool result |
|---|---|---|
| Accept | Keep post-state | Return original successful result unchanged |
| Comment and keep | Keep post-state | Preserve original details; append structured human feedback to text content |
| Dismiss review | Keep post-state | Return original successful result unchanged |
| Reject | Restore pre-state | Throw a clear rejection error after verified restore |
| Reject with comment | Restore pre-state | Throw rejection error containing the comment |
| Submit TODO | No disposition | Submit to sink, acknowledge, and leave review open |

Accept never sends a user or custom message to the model. Slow agent-directed feedback belongs only in the tool result/error.

## Safe rejection

Run rejection through `withFileMutationQueue(path, ...)` while still holding the Slow mutex.

### Existing file

1. Hash the current working file.
2. Require equality with `postHash`.
3. Write pre-state bytes to a temporary sibling file.
4. Apply the preserved mode.
5. Atomically rename over the target.
6. Hash and verify the restored bytes.

### Newly created file

1. Hash the current working file.
2. Require equality with `postHash`.
3. Unlink the file.
4. Verify absence.

Directories created by the built-in `write` remain; Slow v1 restores the file mutation, not parent-directory creation.

### Conflict

If the path is absent unexpectedly, has changed type, or its current raw hash differs:

- do not write or delete anything;
- preserve the newer working state;
- mark the transaction conflicted;
- call `ctx.abort()` if Pi is still running;
- throw an error explaining that restoration was refused because the file changed after review opened.

## Cancellation

Explicit `<leader>bq` dismissal is not rejection: it closes the review UI, keeps the post-state, and returns the original successful tool result unchanged. Only explicit reject actions restore the pre-state.

Other cancellation sources remain failure paths because Pi cannot know that the user intentionally chose to keep the change.

| Cancellation source | Detection |
|---|---|
| User closes Neovim/pane | Unix socket client disconnect |
| Neovim fails during startup | `client_ready` timeout or verified pane death |
| Agent abort signal fires | transaction abort listener/check |
| Session shutdown/reload | runtime cleanup |
| Socket protocol failure | validated connection closes |

Cancellation flow:

1. Attempt the same compare-and-swap restore as explicit reject.
2. On success, throw: `Blink review was cancelled. The file change was restored.`
3. On conflict, preserve current contents, abort the agent, and throw the conflict error.
4. Settle the waiting promise exactly once.
5. Focus owner, close any verified pane, and release the mutex.

Do not poll tmux after Neovim has connected. The socket disconnect is the event-driven pane/client death signal. During startup only, use a short `client_ready` timeout and exact pane health check. Default startup timeout: **5 seconds**.

## Review UI

Slow opens one temporary review pane per transaction and focuses it.

- The review buffer is a copied, read-only Blink buffer, not the working-file buffer.
- After any terminal disposition, focus the Pi owner pane and close the review pane.
- TODO submission and failed actions keep the pane open.
- Display the path, action help, and whether the original file was absent.

Mappings:

| Key | Action |
|---|---|
| `]c` / `[c` | Next/previous hunk |
| `<leader>ba` | Accept |
| `<leader>br` | Reject |
| `<leader>bc` | Comment and keep |
| `<leader>bR` | Reject with comment |
| `<leader>bt` | Submit TODO feedback; review stays open |
| `<leader>bq` | Dismiss review UI and keep the change |
| `?` | Help |

Reject requires no extra confirmation because Slow has not returned the successful tool result and restoration is compare-and-swap protected. Dismiss keeps the change without extra confirmation. Reject-with-comment opens input before requesting rejection.

## Error semantics

A Pi tool `execute()` result cannot set `isError` by returning an `isError` property. Therefore:

- accept/comment-keep return an ordinary result;
- reject/cancel/conflict throw after their filesystem action is resolved;
- built-in failures propagate unchanged;
- TODO failures are protocol action failures and do not settle the tool.

Always preserve built-in `details` for successful results so built-in rendering and session state remain compatible.

## Required tests

Write these before real tmux/Neovim integration:

1. Existing-file accept returns the exact original result.
2. Comment-keep preserves details and appends feedback.
3. Existing-file reject restores raw bytes and mode before throwing.
4. New-file reject deletes only a hash-matching file.
5. Reject refuses a current-hash mismatch.
6. Explicit `<leader>bq` dismissal keeps the post-state and returns the original result.
7. Cancellation conflict aborts once and never overwrites.
8. Built-in failure never opens review.
9. Oversized/binary post-state restores and fails.
10. Parallel edit/write wrappers enter mutation/review one at a time.
11. Socket disconnect settles the review once.
12. Startup timeout restores instead of hanging.
13. TODO success/failure leaves disposition pending.
14. Cleanup during a pending review restores or reports conflict.

## Acceptance criteria

- Every eligible successful built-in edit/write receives exactly one review.
- No second Slow mutation begins before the current review settles.
- Acceptance leaves both working bytes and original result unchanged.
- Explicit rejection never overwrites a changed post-review file.
- Pane/client failure cannot hang the tool.
- Every terminal path releases the mutex and closes verified resources.
