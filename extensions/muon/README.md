# Muon

Muon is the control surface for interaction modes and discoverable skills in this Pi package.

## Modes

```text
/muon mode status
/muon mode off
/muon mode engineering
/muon mode foundation
```

Only one mode is active at a time:

| Mode | System prompt | Synchronized skill bundle |
|---|---|---|
| `off` | Minimal: Pi's default coding-agent prompt | none |
| `engineering` | `modes/engineering-prompt.md` | `skillsets/engineering` |
| `foundation` | `modes/foundation-prompt.md` | `skillsets/foundation` |

Mode changes turn off the other mode's skill bundle and enable the selected mode's bundle. Ponytail and individually enabled standalone skills are preserved. The default mode is `off` with Ponytail, cindex, and handoff enabled.

Mode and skill selection are session-global configuration. Navigating conversation branches with `/tree` does not rewind them; change them explicitly through `/muon`.

## Skills

Muon exposes selected skill roots through Pi `resources_discover`, then reloads the session so Pi refreshes the skill catalog.

```text
/muon skills                         # toggle list UI
/muon skills status                  # show managed and loaded skills
/muon skills engineering             # Engineering skills without changing mode
/muon skills foundation              # Foundation skills without changing mode
/muon skills ponytail
/muon skills off                     # disable profile bundles; preserve standalone skills
/muon skills on cindex
/muon skills off authoring-skills
/muon skills toggle handoff
```

Profiles are `ponytail`, `engineering`, and `foundation`. Standalone managed skills are `authoring-skills`, `cindex`, `handoff`, `ipynb-toolshed`, and `tmux-tdl-logs`.

Pi may also load external skills from package settings, CLI options, `~/.pi/agent/skills`, `~/.agents/skills`, and trusted project skill directories. Muon shows these as read-only `(external)` rows because an extension cannot remove resources loaded by Pi's discovery layer. In tmux, Enter opens an external skill's `SKILL.md` in a Neovim popup.

Changing modes or skills mutates the system prompt and invalidates the provider KV cache. Muon blocks changes above 50% context usage and warns at 20% or higher.

## UI

`/muon` opens the action menu:

- **Status** — current mode, enabled skills, and loaded skill commands
- **Mode** — Minimal, Engineering, or Foundation Mode
- **Skills** — managed toggles and external skill visibility
- **Skill dump** — export Muon-managed skills
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
  engineering-prompt.md
  foundation-prompt.md

skillsets/engineering/
  brainstorming
  planning-risky-changes
  delegating-work
  choosing-test-strategy
  systematic-debugging
  verifying-work
  reviewing-changes
  isolating-work
  finishing-work

skillsets/foundation/
  caveman

skillsets/ponytail/
  ponytail
  ponytail-review
  ponytail-debt

skillsets/standalone/
  authoring-skills
  cindex
  handoff
  ipynb_toolshed
  tmux-tdl-logs
```

The former Superpowers suite is archived under `extensions/superpowers/legacy/` and is not exposed by Muon.
