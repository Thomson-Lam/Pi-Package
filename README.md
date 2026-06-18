# Personal Pi Workflow Package

Private Pi package bundling personal extensions and skills for reproducing the same Pi agent workflow across machines.

## Contents

- `extensions/` — global Pi extensions
- `skills/` — global Pi skills
- `settings.template.json` — non-secret settings template

## Install from GitHub

After pushing this repo to GitHub and tagging a release:

```bash
pi install git:github.com/YOUR_GITHUB_USER/pi-workflow-package@v0.1.0
```

For a private repo over SSH:

```bash
pi install git:git@github.com:YOUR_GITHUB_USER/pi-workflow-package@v0.1.0
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
5. Run `pi`, then authenticate locally with `/login`.

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
pi install git:github.com/YOUR_GITHUB_USER/pi-workflow-package@v0.1.1
```
