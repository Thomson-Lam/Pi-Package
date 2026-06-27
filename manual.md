# Pi Package Git Tag Manual

This repo is a personal Pi package intended to be installed from GitHub by branch or tag.

A tag is the best option when you want a reproducible install on another machine, such as Windows.

Example Pi install from a tag:

```bash
pi install git:github.com/Thomson-Lam/Pi-Package.git@v0.1.3
```

For a private repo over SSH:

```bash
pi install git:git@github.com:Thomson-Lam/Pi-Package.git@v0.1.3
```

After installing, restart Pi or run inside Pi:

```text
/reload
```

## How Git tags work

A Git tag is a named pointer to a specific commit.

Branches move as new commits are added:

```text
main -> commit A -> commit B -> commit C
```

Tags usually do not move:

```text
v0.1.2 -> commit A
main   -> commit C
```

So if Pi installs this package from:

```bash
pi install git:github.com/Thomson-Lam/Pi-Package.git@v0.1.2
```

Pi gets exactly the commit tagged `v0.1.2`, not necessarily the latest `main`.

That is why tags are useful for reproducing the same Pi extensions and skills across machines.

## Check current repo status

Show the current branch, whether it is ahead or behind remote, and whether there are uncommitted files:

```bash
git status --short --branch
```

Show recent commits and where branches/tags point:

```bash
git log --oneline --decorate -8
```

Show recent commits as a graph:

```bash
git log --oneline --decorate --graph -10
```

Show current commit hash:

```bash
git rev-parse --short HEAD
```

## Check current commit vs latest tag

Show all tags, newest first:

```bash
git tag --sort=-creatordate
```

Show the latest reachable tag from the current commit:

```bash
git describe --tags --abbrev=0
```

Show how far the current commit is from the latest tag:

```bash
git describe --tags --long --always --dirty
```

Example output:

```text
v0.1.2-3-g3c91c8f
```

This means:

- latest tag is `v0.1.2`
- current commit is 3 commits after that tag
- current commit hash starts with `3c91c8f`

## Create a new tag at current HEAD

If the latest tag is `v0.1.2`, the next tag could be `v0.1.3`.

Create a tag at the current commit:

```bash
git tag v0.1.3
```

Confirm the tag exists:

```bash
git tag --sort=-creatordate
```

Confirm current commit now describes as the new tag:

```bash
git describe --tags --long --always --dirty
```

Expected output should be similar to:

```text
v0.1.3-0-g3c91c8f
```

The `-0-` means the current commit is exactly on the tag.

## Push current branch and tags to GitHub

Push commits on `main`:

```bash
git push origin main
```

Push the new tag:

```bash
git push origin v0.1.3
```

Or push the branch and all tags together:

```bash
git push origin main --tags
```

## Recommended full workflow

Use this when you are ready to publish the current state for Windows or another machine.

```bash
git status --short --branch
git log --oneline --decorate -5
git describe --tags --long --always --dirty
```

If everything looks good, create a new tag:

```bash
git tag v0.1.3
```

Push the current branch and tags:

```bash
git push origin main --tags
```

Then install that exact version on Windows:

```bash
pi install git:github.com/Thomson-Lam/Pi-Package.git@v0.1.3
```

Or over SSH:

```bash
pi install git:git@github.com:Thomson-Lam/Pi-Package.git@v0.1.3
```

Then restart Pi or run:

```text
/reload
```

## If you tag the wrong commit before pushing

Delete the local tag:

```bash
git tag -d v0.1.3
```

Create it again at the current commit:

```bash
git tag v0.1.3
```

## If you already pushed the wrong tag

Be careful. Tags are supposed to be stable. Rewriting pushed tags can confuse other machines.

For a personal repo, it is possible, but do it intentionally.

Delete the remote tag:

```bash
git push origin :refs/tags/v0.1.3
```

Delete the local tag:

```bash
git tag -d v0.1.3
```

Recreate the tag at the current commit:

```bash
git tag v0.1.3
```

Push the corrected tag:

```bash
git push origin v0.1.3
```

On another machine that already fetched the old tag, you may need to refresh tags:

```bash
git fetch --tags --force
```

## Rule of thumb

Use `@main` when you want a machine to follow the latest development version:

```bash
pi install git:github.com/Thomson-Lam/Pi-Package.git@main
pi update --extensions
```

Use a tag when you want reproducibility:

```bash
pi install git:github.com/Thomson-Lam/Pi-Package.git@v0.1.3
```
