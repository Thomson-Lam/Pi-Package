---
name: finishing-work
description: >
  Use when verified work is ready for merge, pull request, preservation, or
  cleanup.
---

# Finishing Work

Finish by preserving verified work and returning integration choices that belong
to the user. Do not turn branch mechanics into an automatic publication step.

## Confirm readiness

Before integration, inspect repository status and verify the change at the level
required by its risk. Confirm that intended commits or uncommitted changes are
present, relevant tests have meaningful results, and known limitations are
visible.

A failing required check means the work is not ready for merge or pull request.
An unavailable check may still permit preservation, but report the limitation
rather than presenting the branch as fully verified.

## Determine workspace ownership

Identify the base branch, current branch or detached state, and whether the
workspace is a normal checkout, user-managed worktree, or harness-managed
workspace. This determines which integration and cleanup operations are safe.

## Return consequential choices

Obtain user authorization before operations that publish, merge, discard, or
permanently remove work. An explicit request for the operation in the current
task is authorization; do not ask for redundant confirmation unless the target
or consequences changed, the authorization is stale or ambiguous, or new risk
was discovered. Destructive discard still requires unambiguous confirmation.
Relevant choices may include:

- merge locally
- push and create a pull request
- keep the branch or workspace for later
- create a branch from a detached workspace
- discard the work

Present only choices valid for the detected environment. Do not require a fixed
menu when the user has already requested one outcome.

## Execute safely

For a local merge, update the intended base only as authorized, merge the work,
and verify the integrated result before deleting its source branch or worktree.

For a pull request, preserve the workspace unless the user or harness owns a
different cleanup policy. Never force-push unless explicitly authorized.

For discard, describe what will be lost and obtain unambiguous confirmation
before deletion.

Remove only worktrees created and owned by this workflow. Leave user-managed and
harness-managed workspaces to their owner. Never delete a branch or workspace
before confirming that wanted changes are integrated, pushed, or intentionally
discarded.
