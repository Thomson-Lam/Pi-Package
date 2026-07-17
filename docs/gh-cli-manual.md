## How `gh` works

`gh` is GitHub’s official CLI. It communicates with GitHub’s API using your authenticated account.

The skill’s wrapper runs commands such as:

```bash
gh issue list
gh issue view 123
gh issue create ...
gh pr create ...
```

Inside a Git repository, `gh` identifies the target repository from the Git remote—normally `origin`:

```bash
git remote get-url origin
```

Outside that repository, or when targeting another repository, supply:

```bash
--repo OWNER/REPO
# shorthand:
-R OWNER/REPO
```

## Authentication is required

Your machine currently has `gh` installed, but it was not authenticated when checked.

Run this once in your terminal:

```bash
gh auth login
```

Choose:

1. **GitHub.com**
2. **HTTPS** or **SSH** for Git operations
3. **Login with a web browser**—usually simplest
4. Copy the displayed one-time code into the browser

Then verify:

```bash
gh auth status
```

You should see your GitHub username and an active account.

### Token alternative

For noninteractive environments:

```bash
export GH_TOKEN="your-token"
gh auth status
```

Avoid storing the token directly in shell history or committing it to a file. Interactive `gh auth login` stores credentials through the system credential store when available.

## Is additional configuration required?

Usually, no. Authentication plus a valid Git remote is sufficient:

```bash
gh auth login
cd /path/to/repository
git remote -v
gh issue list
```

Optional configuration can be inspected with:

```bash
gh config list
```

You generally do not need to change it.

## Permissions

What the wrapper can do depends on your GitHub permissions:

- **Read public issues:** normally available once authenticated
- **Read private issues:** requires repository access
- **Create issues:** requires issues to be enabled and your account to have access
- **Create PRs:** requires a pushed branch on the repository or a fork

Creating a PR commonly looks like:

```bash
git push -u origin my-branch
gh pr create
```

The wrapper disables interactive prompts, so the agent supplies the required title and body explicitly.

## Quick readiness check

Run:

```bash
gh auth login
gh auth status
git remote -v
gh issue list --limit 5
```

If the final command lists issues, the skill is ready. Then enable it in Pi:

```text
/muon skills on github-issues-prs
```
