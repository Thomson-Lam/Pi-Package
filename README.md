# Personal Pi Workflow Package

Private Pi package bundling personal extensions and skills for reproducing the
same Pi agent workflow across machines.

## Contents

- `extensions/` — global Pi extensions
- `extensions/muon/skillsets/` — Muon-governed Pi skills (exposed via
  `/muon skills`)
- `settings.template.json` — non-secret settings template
- `scripts/` — setup scripts for installing companion npm Pi packages and this
  package by tag

## Install from GitHub

After pushing this repo to GitHub and tagging a release:

```bash
pi install git:github.com/Thomson-Lam/Pi-Package.git@v0.1.0
```

For a private repo over SSH:

```bash
pi install git:git@github.com:Thomson-Lam/Pi-Package.git@v0.1.0
```

For local repo clone, clone the repo, point Pi to this local path using
`pi install`, then run `npm install` in the cloned repo path. This project uses
zod under `olive-agents`.

Then restart Pi or run `/reload`.

## Companion npm Pi packages

This repo bundles personal extensions and skills, but some useful extensions are
installed separately from the npm registry. The helper scripts install the
current npm Pi package set:

- `npm:pi-interactive-shell` — interactive terminal overlays, subagent dispatch,
  and monitor sessions.
- `npm:pi-opencode-bridge` — OpenCode provider/model bridge for Pi.
- `npm:@nerisma/pi-tool-border` — theme-colored left border on tool output.
- `npm:@nerisma/pi-turn-usage-notifications` — per-turn token and cost
  notifications.
- `npm:@javargasm/pi-usage-bars` — footer usage bars and `/usage` command for
  supported providers.

On macOS/Linux:

```bash
./scripts/install-npm-packages.sh
```

On Windows PowerShell:

```powershell
.\scripts\install-npm-packages.ps1
```

Then restart Pi or run `/reload`.

## Windows setup

1. Install Node.js.
2. Install Git for Windows, which provides Git Bash.
3. Install Pi:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

4. Install this package with one of the `pi install git:...` commands above.
5. Install companion npm Pi packages:

```powershell
.\scripts\install-npm-packages.ps1
```

6. Run `pi`, then authenticate locally with `/login`.

If Pi cannot find bash on Windows, add this to `~/.pi/agent/settings.json`:

```json
{
  "shellPath": "C:\\Program Files\\Git\\bin\\bash.exe"
}
```

## Update workflow

```bash
git add .
git commit -m "update pi workflow"
git tag v0.1.1
git push origin main --tags
```

Then update the installed package ref in Pi:

```bash
pi install git:github.com/Thomson-Lam/Pi-Package.git@v0.1.1
```

## Development vs reproducible installs

Use different install modes depending on whether you are actively editing the
extensions/skills or reproducing a stable setup on another machine.

| Scenario                          | Where extension/skill code lives                                                    | Pi configuration command                                          | Notes                                                                                                                                               |
| --------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local development on this Mac     | `~/pi-package-dev`                                                                  | `pi install /Users/tlam/pi-package-dev`                           | Pi loads directly from this working tree. Edit files here, then run `/reload` in Pi. Commit and push when ready.                                    |
| Tracking latest GitHub `main`     | Pi-managed clone under `~/.pi/agent/git/github.com/Thomson-Lam/Pi-Package`          | `pi install git:github.com/Thomson-Lam/Pi-Package.git@main`       | Convenient for a secondary machine that should follow latest. Do not edit the Pi-managed clone directly. Update with `pi update --extensions`.      |
| Reproducible Windows/stable setup | Pi-managed clone under `~/.pi/agent/git/github.com/Thomson-Lam/Pi-Package` at a tag | `pi install git:github.com/Thomson-Lam/Pi-Package.git@v0.1.0`     | Best for reproducibility. Tags point to a specific commit, so the installed workflow is stable. Move to a new version with `pi install ...@v0.1.1`. |
| Private repo over SSH             | Pi-managed clone under `~/.pi/agent/git/github.com/Thomson-Lam/Pi-Package`          | `pi install git:git@github.com:Thomson-Lam/Pi-Package.git@v0.1.0` | Use this if HTTPS cannot access the repo. Requires SSH keys configured on the machine.                                                              |

Recommended setup:

- On the main development Mac, use the local path install:

```bash
pi remove git:github.com/Thomson-Lam/Pi-Package.git
pi install /Users/tlam/pi-package-dev
```

- On the Windows laptop, use a tagged GitHub install for reproducibility:

```bash
pi install git:github.com/Thomson-Lam/Pi-Package.git@v0.1.0
```

- While iterating quickly on Windows or another secondary machine, use `@main`
  instead:

```bash
pi install git:github.com/Thomson-Lam/Pi-Package.git@main
pi update --extensions
```

Do not edit files inside `~/.pi/agent/git/...`; that directory is managed by Pi
and can be reset or cleaned during package updates.

## Fresh clone development setup

Use this path when you want to actively develop this package on a new machine,
rather than installing a pinned GitHub version into Pi's managed package cache.

1. Clone the source repo somewhere you control:

```bash
git clone https://github.com/Thomson-Lam/Pi-Package.git ~/pi-package-dev
cd ~/pi-package-dev
```

For SSH:

```bash
git clone git@github.com:Thomson-Lam/Pi-Package.git ~/pi-package-dev
cd ~/pi-package-dev
```

2. Install Pi if needed:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

3. Install this package's local npm dependencies, then point Pi at the local
   working tree:

```bash
npm install
pi install ~/pi-package-dev
```

If replacing a previous GitHub package install, remove it first:

```bash
pi remove git:github.com/Thomson-Lam/Pi-Package.git
pi install ~/pi-package-dev
```

4. Start Pi, authenticate if needed, and reload resources after edits:

```bash
pi
```

Inside Pi:

```text
/login
/reload
```

In this setup, extension and skill code lives in the cloned working tree at
`~/pi-package-dev`. Edit files there, run `npm install` after dependency
changes, commit and push normally, then run `/reload` in Pi to pick up local
changes. Do not edit Pi-managed package clones under `~/.pi/agent/git/...`.

For reproducible setup, prefer installing a tag instead of the local clone:

```bash
pi install git:github.com/Thomson-Lam/Pi-Package.git@v0.1.0
```

## dev 

Run `npm install -g --ignore-scripts @earendil-works/pi-coding-agent` to install when using Pi in this repo for dev work.
