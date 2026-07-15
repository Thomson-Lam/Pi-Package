---
name: isolating-work
description: >
  Use when work is risky, long-running, experimental, parallel, or should not
  disturb the current checkout.
---

# Isolating Work

Use the lightest isolation that protects the current workspace and prevents
workers from interfering with one another.

## Check the environment first

Determine whether the harness already placed the session in a worktree,
sandbox, container, or other isolated workspace. Reuse host-managed isolation
rather than creating nested or invisible state.

Consider isolation when:

- the current checkout contains unrelated or uncommitted work
- an experiment may be discarded
- multiple workers need separate writable trees
- setup or generated files would pollute the main checkout
- the change is risky or likely to span sessions

A small, safe edit in a clean workspace may not justify a new worktree.

## Choose the mechanism

Prefer a native harness workspace or worktree feature when available. It can
track ownership and cleanup more reliably than manual Git commands.

When using Git worktrees directly:

- follow an explicit project location convention if one exists
- otherwise use an ignored project-local worktree directory
- verify the directory is ignored before creating it
- use a distinct branch for work that should be retained
- do not create a linked worktree from inside an incompatible repository state

Do not install dependencies automatically merely because a workspace was
created. Run only setup needed for the task and consistent with project
instructions.

## Establish a baseline

Inspect repository status and run focused baseline checks when pre-existing
failures could be confused with regressions. The required breadth depends on the
change; creating isolation does not itself justify an expensive full suite.

If the baseline is already failing, record the relevant failures before making
changes. Ask the user only when proceeding would make ownership of those
failures materially ambiguous or unsafe.

## Preserve ownership

Track whether the harness, user, or this workflow created the workspace. Do not
remove harness-managed or user-managed worktrees. Cleanup belongs to the owner
and should occur only after work is safely integrated, explicitly discarded, or
otherwise preserved.
