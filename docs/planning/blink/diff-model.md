# Blink diff and version model

Status: **frozen for implementation**  
Parent: [README.md](README.md)

Blink renders origin-relative changes. It does not use Git HEAD, the Git index, or Gitsigns as its authority.

## Terms

| Term | Meaning |
|---|---|
| Origin | Immutable bytes captured immediately before Blink's first mutation of a path in the current runtime |
| Slow pre-state | Per-transaction origin used for Slow review/restoration |
| Blitz version | Exact post-tool bytes retained in the review timeline |
| Cumulative diff | Diff from immutable origin directly to a selected version |
| Absent origin | Marker that the path did not exist before its first built-in `write` |

“Absolute diff” in earlier discussion means **cumulative origin-relative diff** in these specifications.

## Origin selection

| Initial path state | Origin |
|---|---|
| Existing regular text file | Exact current on-disk bytes immediately before first Blink mutation |
| Existing file with uncommitted/user changes | Those current bytes, including the user's changes |
| New path written by Pi | `absent` |
| Git repository file | Same working-file rule; Git state is irrelevant |
| Non-Git project | Same behavior |

Origins never advance during a Blitz runtime. Slow captures a fresh pre-state for each serialized transaction.

## Blitz comparison rules

### New file

An absent origin is rendered as additions only.

Version 1:

```diff
+first line
+second line
```

If a later version changes the first line, it still compares against absence:

```diff
+changed first line
+second line
```

It does not show the earlier generated `first line` as a red deletion. The earlier version buffer remains available for timeline inspection.

### Existing file

Origin:

```text
A
B
C
```

Version 1:

```text
A
B changed
C
```

Version 2:

```text
A
B changed
C
D
```

Version 2 renders directly against origin:

```diff
 A
-B
+B changed
 C
+D
```

It is not a relative Version 1 → Version 2 diff.

## Slow comparison rules

Slow renders the exact pre-tool state against the exact post-tool state.

- Existing file: normal red/green diff.
- New file: all current lines are additions.
- Accept keeps post-state.
- Reject restores pre-state or expected absence.

Slow has no cross-transaction origin or retained timeline.

## Raw bytes and visual text

Filesystem safety and display have different representations.

| Concern | Representation |
|---|---|
| Eligibility size | Raw byte count |
| Slow compare-and-swap | SHA-256 of raw bytes |
| Snapshot and restore | Raw bytes |
| File mode | Preserved separately for Slow existing-file restore |
| Neovim diff | UTF-8 text normalized for visual calculation only |

Rules:

- A NUL byte marks content unsupported/binary.
- Invalid UTF-8 is unsupported rather than silently replaced.
- Preserve raw CRLF/LF bytes in snapshots and restoration.
- Normalize line endings only in Neovim's in-memory diff inputs.
- Test and visibly mark missing final newline where Neovim permits.
- The limit is inclusive: exactly `15 * 1024 * 1024` bytes is eligible; one byte more is unsupported.

## Diff calculation

Use Neovim's native diff:

```lua
vim.diff(origin_text, version_text, {
  result_type = "indices",
  algorithm = "histogram",
})
```

For absent origins, skip `vim.diff()` and mark every current line added.

A hunk contains origin start/count and version start/count. Store calculated hunks in buffer state for navigation and rendering; recalculate only when that version buffer is created/refreshed.

## Rendering

Blink buffers contain the selected version's full current text.

- Added current lines receive green/addition highlights and signs.
- Deleted origin lines are rendered as red virtual lines adjacent to the surviving location.
- Replacements show deleted virtual lines followed by added current lines.
- Context/unchanged lines remain normal.
- Use a dedicated Blink extmark namespace.
- Re-rendering clears and replaces that namespace; never accumulate duplicate extmarks.
- Gitsigns may be detached or suppressed in Blink buffers to avoid displaying another baseline.

Exact terminal colors come from the user's theme. Tests assert hunk positions and highlight/extmark categories, not RGB values.

## Location behavior

| Event | Initial cursor |
|---|---|
| Built-in edit with `firstChangedLine` | That line in the selected version |
| Existing-file write | First cumulative hunk |
| New file | Line 1 |
| Empty result | Line 1/waiting-safe location |

`[c` and `]c` wrap through Blink hunks. A version with no calculated hunk leaves the cursor unchanged and reports “No Blink changes.”

## Buffer identity and safety

Blink never opens the working path as its review buffer. It loads copied snapshot content into a scratch buffer.

```lua
vim.bo[buf].buftype = "nofile"
vim.bo[buf].bufhidden = "hide"
vim.bo[buf].swapfile = false
vim.bo[buf].buflisted = true
vim.bo[buf].modifiable = false
vim.bo[buf].readonly = true
```

Also install a buffer-local write blocker. Refresh by temporarily setting `modifiable=true`, replacing lines from the trusted snapshot, then restoring options in a `finally`-equivalent protected call.

Names:

```text
blink://<display-path>@slow-<transaction-id>
blink://<display-path>@<blitz-version-id>
```

The display path is presentation only; Pi resolves all actions through opaque IDs.

## Snapshot accounting

- Snapshot files use opaque filenames and mode `0600`.
- Origins count toward Blitz's 100 MiB runtime byte limit.
- Origins do not count toward the 100-version limit.
- An origin remains while any retained version for its file exists.
- Slow snapshots are removed after the transaction and pane settle.
- Blitz snapshots are removed on eviction or runtime cleanup.

## Required tests

Use byte and text fixtures for:

1. absent origin;
2. empty new file;
3. existing file insertion;
4. deletion;
5. replacement;
6. multiple distant hunks;
7. cumulative Version 2 compared to origin rather than Version 1;
8. new Version 2 still rendered entirely as additions;
9. pre-existing uncommitted content included in origin;
10. empty existing file;
11. no final newline;
12. LF and CRLF visual equivalence with raw preservation;
13. NUL rejection;
14. invalid UTF-8 rejection;
15. exactly 15 MiB accepted;
16. 15 MiB plus one byte rejected;
17. deleted virtual-line placement;
18. hunk navigation wraparound;
19. extmark refresh without duplication;
20. working file never opened as the review buffer.

## Acceptance criteria

- Every Blitz version uses one immutable working-file origin.
- New files render as additions only for every version.
- Existing files render cumulative red/green changes against their original on-disk bytes.
- Git state cannot alter Blink diffs.
- Slow safety decisions use raw bytes, never normalized display text.
- Review buffers cannot accidentally write the working file.
