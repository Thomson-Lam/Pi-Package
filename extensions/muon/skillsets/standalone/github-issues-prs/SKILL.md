---
name: github-issues-prs
description: Read GitHub issues and create GitHub issues or pull requests with the gh CLI. Use when asked to inspect an issue, list repository issues, file an issue, or open a PR.
compatibility: Requires git and an authenticated gh CLI.
---

# GitHub Issues and PRs

Use the bundled `scripts/github-md` wrapper. Resolve it relative to this `SKILL.md` and invoke its absolute path from any repository. It keeps reads compact and delegates authentication, repository detection, and writes to `gh`.

## Read issues

Read any issue by number or URL; assignment does not matter:

```bash
<SKILL_DIR>/scripts/github-md issue-read 123
<SKILL_DIR>/scripts/github-md issue-read https://github.com/OWNER/REPO/issues/123
```

List open issues without restricting assignment:

```bash
<SKILL_DIR>/scripts/github-md issue-list
```

Only add an assignment filter when requested:

```bash
<SKILL_DIR>/scripts/github-md issue-list --assignee @me
```

Native `gh issue list` filter flags may be appended. Do not pass `--json`, `--jq`, or `--template`; the wrapper owns output formatting. Use `--repo OWNER/REPO` when the target is not the current repository.

## Create an issue

Write the body to a temporary Markdown file, then create the issue non-interactively:

```bash
<SKILL_DIR>/scripts/github-md issue-create \
  --title "Short actionable title" \
  --body-file /tmp/github-issue.md
```

Append native flags such as `--label`, `--assignee`, or `--repo` only when needed.

## Create a pull request

Confirm the branch is pushed, write the PR body to a temporary Markdown file, then create it:

```bash
<SKILL_DIR>/scripts/github-md pr-create \
  --title "Short change summary" \
  --body-file /tmp/github-pr.md
```

Append `--base`, `--head`, `--draft`, `--reviewer`, or `--repo` only when needed. Use `Closes #123` in the body only when merging the PR should close that issue.

## Rules

- Run `gh auth status` only when authentication is uncertain or a command fails for authentication.
- Before writing, use `git remote -v` or `--repo OWNER/REPO` if the target repository is ambiguous.
- Show the proposed title and body before creating unless the user explicitly asked to submit it immediately.
- Never add `--assignee @me` implicitly; unassigned and other users' issues are valid inputs.
- Prefer the wrapper over `gh api`. Use native `gh` directly only for an option the wrapper passes through or a capability outside this skill.
- Return the created issue or PR URL.
