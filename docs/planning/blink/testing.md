# Blink test and smoke-test plan

Status: **frozen for implementation**  
Parent: [README.md](README.md)

Implement Blink test-first. Each gate must have a runnable failing check before its production code and pass before the next integration layer begins.

## Test rules

- Use Node's built-in `node:test` and `assert` for TypeScript/filesystem/coordinator tests.
- Prefer Node's native TypeScript support or Pi's existing jiti loader; do not add a test framework solely to load TypeScript.
- Use temporary directories for all filesystem tests.
- Use `nvim --headless` for Lua state, diff, buffer, and protocol tests.
- Use an isolated tmux server for every automated tmux test.
- Never target the default tmux server from automated tests.
- Fake Pi, tmux, Neovim, and sinks until the component under test specifically requires the real dependency.
- No model call is required before final manual smoke testing.

## Gate 1: revisions and diff fixtures

Write tests first for:

- existing and absent origins;
- regular text eligibility;
- NUL/invalid UTF-8/symlink rejection;
- inclusive 15 MiB limit;
- raw hashing and mode capture;
- atomic Slow restore and new-file deletion;
- compare-and-swap conflict refusal;
- cumulative existing-file fixtures;
- additions-only new-file fixtures;
- CRLF and missing-final-newline behavior.

Exit gate: pure logic and temporary-filesystem tests pass without Pi, tmux, or Neovim.

## Gate 2: built-in wrappers

Use fake built-in definitions/operations before real Pi integration.

Prove:

- Off delegates once and returns the exact result;
- current `ctx.cwd` is used;
- schemas, prompt metadata, renderers, argument preparation, and result details are retained;
- one mode is captured for a whole run;
- mode changes are refused while busy;
- Slow global mutex serializes edit and write together;
- Blitz write captures exact parameter bytes;
- Blitz edit operation captures exact bytes passed to `writeFile`;
- a later same-file mutation cannot alter an earlier queued payload;
- first-origin promise is idempotent under parallel calls;
- background job delay does not delay Blitz tool result.

Exit gate: no pane, socket, or real Neovim is involved.

## Gate 3: protocol and runtime directory

Test [protocol.md](protocol.md) with fake Node socket peers.

Include framing, validation, duplicate requests, one-client policy, Slow disconnect, Blitz replay, restrictive permissions, and repeated cleanup.

Exit gate: protocol state can be driven entirely by fake messages.

## Gate 4: Neovim client

Run pure/headless checks with Blink's runtime path added explicitly.

Example shape:

```bash
nvim --headless -u NONE \
  --cmd "set runtimepath+=/absolute/path/to/extensions/blink/nvim" \
  -l extensions/blink/tests/nvim/run.lua
```

Test:

- state snapshot replacement;
- version insertion/order/eviction;
- unique listed buffers for the same path;
- working path is never opened as review buffer;
- read-only/write blocking;
- cumulative `vim.diff()` hunks;
- additions-only absent origin;
- deleted virtual lines;
- extmark replacement;
- file/hunk wraparound;
- pin/unread/auto-follow reducer behavior;
- buffer-local mappings and descriptions;
- optional plugin absence;
- fake socket messages and action request IDs.

Then run a second headless integration under the user's normal config to catch plugin interactions. Correctness tests must still pass under `-u NONE`.

## Gate 5: tmux adapter

Use a unique server:

```bash
tmux -L blink-test-<pid> -f /dev/null new-session -d ...
```

Use a fake editor process that records environment/arguments and waits.

Test:

- exact owner targeting with several panes/windows;
- detached right split creation;
- returned pane ID;
- Blink metadata;
- explicit focus after creation;
- no focus call on ordinary update;
- verified owner focus before close;
- close refuses mismatched metadata;
- death detection;
- Blitz respawn and focus;
- paths containing spaces and quotes;
- missing `TMUX_PANE`;
- teardown always kills only the isolated server.

Exit gate: no test command can address the default server.

## Gate 6: coordinator tests

### Slow

Use fake Pi context, tools, socket client, pane, and sink. Cover every required test in [slow.md](slow.md), especially parallel serialization, disconnect cancellation, restore conflict, and exactly-once settlement.

### Blitz

Use a deliberately blocked fake background worker to prove the tool result returns first. Cover exact capture, timeline ordering, focus policy, replay, eviction, feedback, TODO, abort, and cleanup from [blitz.md](blitz.md).

Exit gate: all mode behavior is deterministic without launching tmux.

## Gate 7: component integration

Run in this order:

1. Pi extension coordinator ↔ fake Neovim client.
2. Pi extension socket ↔ real headless Neovim client.
3. tmux adapter ↔ fake editor.
4. tmux adapter ↔ real Neovim with fake Blink server.
5. Full Pi ↔ tmux ↔ Neovim smoke modes.

Do not skip directly to step 5.

## Automated smoke checks

Add one lightweight repository smoke script that verifies:

- required Blink runtime/assets exist;
- `/blink` registration and mode strings exist;
- plan-mode entrypoint has been removed only after migration;
- root package wildcard discovers Blink once;
- no stale `plan_diff` or removed plan command references remain in user docs;
- all focused test commands are documented.

This is structural coverage, not a substitute for behavioral tests.

## Manual Slow smoke test

Use two small temporary text files in a disposable test project.

| Scenario | Expected result |
|---|---|
| Enable Slow outside tmux | Refused; mode unchanged |
| Accept existing-file edit | Pane focuses; original tool result completes; file remains changed |
| Reject existing-file edit | Original bytes/mode restored; model receives error |
| Comment and keep | File remains; feedback appears in same tool result |
| Reject new write | New file removed |
| `<leader>bq` dismiss | Review UI closes; change remains; original tool result completes |
| Close pane without dismissal | Change restored and tool errors; no hang |
| Modify file externally before reject | Restore refused; newer bytes preserved; agent aborts |
| Two parallel writes | Reviews occur one at a time |
| TODO with/without sink | Success remains pending; failure remains pending |
| `/blink` while running | Refused |
| Reload while idle | Pane/socket/history close; selected mode restores |

## Manual Blitz smoke test

Ask the agent to perform several edits without waiting for review.

| Scenario | Expected result |
|---|---|
| First change | Tool returns; pane appears/focuses asynchronously |
| Several same-file edits | Separate exact version buffers appear |
| Existing-file Version 2 | Diff remains against original pre-first-edit bytes |
| New-file versions | Every current line is green in every version |
| Navigate old version | Snipe and `[f`/`]f` can select it |
| Pin active version | New version becomes unread without navigation theft |
| Move to Pi pane | Existing review pane does not steal focus on update |
| Dismiss pane | Agent continues; history remains server-side |
| Next change after dismissal | Pane respawns/focuses and retained history replays |
| Agent comment | Steer while running; normal turn while idle |
| TODO | Sink receives it; model does not |
| Confirm abort | `ctx.abort()` called; history/files unchanged |
| 101 versions or 100 MiB | Oldest buffers evicted with warning |
| File >15 MiB | Mutation remains, version skipped with notice |
| `/blink off` | Pane/socket/snapshots/history removed; files retained |

## Coding-agent QA prompt

Use this after all automated gates pass:

```text
You are validating the Blink Pi extension, not implementing new features.

Read completely:
- AGENTS.md
- docs/planning/blink/README.md and every linked specification in its reading order
- the implemented extensions/blink files and tests
- the current installed Pi extension/TUI/tmux docs named by the Blink README

Rules:
- Run existing deterministic tests first.
- Never run automated tmux commands against the default server; use `tmux -L blink-qa-<pid> -f /dev/null`.
- Do not modify working files except disposable fixtures under a temporary test project.
- Do not edit the implementation during this pass.
- Compare behavior to the frozen specs, not to assumptions from the old plan-mode extension.
- Record exact commands, outcomes, and relevant logs.

Validate in order:
1. revision/diff tests;
2. wrapper and coordinator tests;
3. protocol tests;
4. headless Neovim tests under `-u NONE`;
5. isolated tmux tests;
6. component integrations;
7. supervised manual Slow smoke scenarios;
8. supervised manual Blitz smoke scenarios.

Pay special attention to:
- Blitz tool results returning before blocked review delivery;
- exact same-file version bytes;
- cumulative origin-relative diffs;
- new-file additions-only rendering;
- Slow pane-close restoration and conflict refusal;
- no focus theft for updates to an existing inactive pane;
- verified pane cleanup;
- 15 MiB, 100-version, and 100 MiB boundaries;
- no model context from TODO sinks;
- no accept/reject behavior in Blitz.

Return a concise report with:
- PASS/FAIL per gate;
- command and evidence for each failure;
- spec location violated;
- whether the failure risks data loss, blocks release, or is cosmetic.
Do not propose unrelated enhancements.
```

## Release gate

Blink is not ready to replace plan-mode until:

- every automated gate passes;
- both manual smoke tables pass;
- no Slow cancellation path hangs or overwrites a conflict;
- no Blitz job delays the returned tool result on review infrastructure;
- cleanup leaves no live verified pane/socket;
- migration documentation is updated and reviewed.
