# Muon

Muon is the control surface for interaction modes and discoverable skills in this Pi package.

## Modes

```text
/muon status
/muon off
/muon build
/muon spec
/muon mode      # interactive picker
```

Only one mode is active at a time:

| Mode | System prompt | Synchronized skill bundle |
|---|---|---|
| `off` | Minimal: Pi's default coding-agent prompt | none |
| `build` | `modes/build-prompt.md` | Ponytail, cindex, github-issues-prs, handoff, and tmux-tdl-logs |
| `spec` | `modes/spec-prompt.md` | `yagni-product-design` |

Activating Build enables Ponytail, cindex, github-issues-prs, handoff, and tmux-tdl-logs. They remain independently toggleable afterward. Activating Spec enables `yagni-product-design`; leaving Spec disables that mode-owned skill. The default mode is `off` with Ponytail, cindex, github-issues-prs, handoff, and tmux-tdl-logs enabled.

Mode and skill selection are session-global configuration. Navigating conversation branches with `/tree` does not rewind them; change them explicitly through `/muon`.

## Skills

Muon exposes selected skill roots through Pi `resources_discover`, then reloads the session so Pi refreshes the skill catalog.

```text
/mus                                 # open skill selection and apply changes
/muon skills                         # same toggle list UI
/muon skills status                  # show managed and loaded skills
/muon skills ponytail
/muon skills off                     # disable profile bundles; preserve standalone skills
/muon skills on cindex
/muon skills off authoring-skills
/muon skills toggle handoff
```

The managed profile is `ponytail`. Standalone managed skills are `authoring-skills`, `cindex`, `github-issues-prs`, `handoff`, `ipynb-toolshed`, and `tmux-tdl-logs`. The Spec-owned skill is `yagni-product-design`.

When `handoff` is enabled, Muon also registers continuation commands:

```text
/handoff  # select a docs/handoff TODO list and inject selected file contents
/hcon     # choose which handoff file-context bullets to read+inject, then select TODOs
```

Both commands read `docs/handoff/handoff-<subject>.md` plus `docs/handoff/handoff-<subject>.todos.md`, queue the selected files' current contents for the next `before_agent_start`, and populate the editor with selected TODO tasks without auto-submitting.

Pi may also load external skills from package settings, CLI options, `~/.pi/agent/skills`, `~/.agents/skills`, and trusted project skill directories. Muon shows these as read-only `(external)` rows because an extension cannot remove resources loaded by Pi's discovery layer. In tmux, Enter opens an external skill's `SKILL.md` in a Neovim popup.

## UI

`/muon` opens the action menu:

- **Skills** — managed toggles and external skill visibility
- **Mode** — Minimal, Build, or Spec
- **Skill dump** — export Muon-managed skills
- **Status** — current mode, enabled skills, and loaded skill commands
- **Help** — command reference

The Mode and Skills dialogs support `j`/`k`, arrow keys, Enter, and Esc. The status widget shows both active mode and enabled skills.

## Skill dump

```text
/muon skill-dump [pi|agents|claude|codex]
```

| Target | Destination |
|---|---|
| `pi` | `.pi/skills` |
| `agents` | `.agents/skills` |
| `claude` | `.claude/skills` |
| `codex` | `.codex/skills` |

Existing dumped skill directories with matching skill names are replaced.

## Bundled resources

```text
modes/
  build-prompt.md
  spec-prompt.md

skillsets/ponytail/
  ponytail
  ponytail-review
  ponytail-debt

skillsets/standalone/
  authoring-skills
  cindex
  github-issues-prs
  handoff
    /handoff and /hcon continuation commands
  ipynb_toolshed
  tmux-tdl-logs
  yagni-product-design
```

Retired resources are not exposed by Muon:

- Engineering Mode is archived under `archive/engineering-mode/`.
- Foundation Mode is archived under `archive/foundation-mode/`.
