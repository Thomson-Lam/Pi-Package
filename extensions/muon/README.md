# Muon

Muon is a personal Pi extension for governing skill profiles and individual skills in the Pi context window.

## Skills

Muon is the control surface for this package's skills. It exposes selected skill roots through Pi `resources_discover`, then reloads the session so Pi refreshes the skill catalog.

```text
/muon skills                         # toggle list UI
/muon skills status                  # show Muon-governed and currently loaded skills
/muon skills on cindex
/muon skills off ipynb-toolshed
/muon skills toggle handoff
/muon skills off|auto|ponytail|superpowers  # profile shortcuts
```

Default is `off`. Changing skills mutates the system prompt skill ledger and invalidates the provider KV cache for the current conversation. When context is >50%, Muon blocks toggles. At 20%+ context, Muon warns before proceeding and suggests `/tree` or a fresh session.

| Toggle/profile          | Exposed skill roots |
| ----------------------- | ------------------- |
| `ponytail` profile      | `skillsets/muon`, `skillsets/ponytail` |
| `superpowers` profile   | `skillsets/muon`, `skillsets/superpowers` |
| `cindex`                | `skills/cindex` |
| `handoff`               | `extensions/handoff/skills/handoff` |
| `ipynb-toolshed`        | `skills/ipynb_toolshed` |

`using-muon` routes between available skills when a profile exposes the Muon router. In `superpowers` mode, `yagni-scope-guard` is available to constrain scope creep without exposing Ponytail.

Pi can also load skills from package `pi.skills`, settings, CLI `--skill`, `~/.pi/agent/skills`, `~/.agents/skills`, project `.pi/skills`, and trusted project/ancestor `.agents/skills`. Muon detects those already-loaded external skills dynamically through Pi command metadata and shows them in `/muon skills` with `(external)`. External rows are not toggleable because extensions cannot remove resources loaded by Pi's own discovery layer; pressing Enter on an external row opens its `SKILL.md` in a tmux popup with Neovim when Pi is running inside tmux. Without tmux, Muon shows a red “No tmux detected” message.

## Manual commands

```text
/muon                 # open the Muon action menu
/muon help            # show UI-only help
/muon status          # show skill status
/muon skills          # open skill toggle modal
/muon skills status|list
/muon skills on|off|toggle <skill-id>
/muon skills off|auto|ponytail|superpowers  # profile shortcut
/muon skill-dump [pi|agents|claude|codex]
```

The `/muon` menu supports `j`/`k` navigation, Enter to select, `h`/`?` for help, and Esc to cancel. The `/muon skills` modal supports `j`/`k` navigation, Enter to toggle managed skills, Enter on external skills to open `SKILL.md` in a tmux popup, type-to-search, and Esc to apply + reload.

## Skill dump

`/muon skill-dump` writes every Muon-managed skill, regardless of enabled state, into a project-local universal skill folder:

| Target | Destination |
| ------ | ----------- |
| `pi` | `.pi/skills` |
| `agents` | `.agents/skills` |
| `claude` | `.claude/skills` |
| `codex` | `.codex/skills` |

The UI flow is `/muon` → `Skill dump` → choose target → Enter. Existing dumped skill directories with matching skill names are replaced.

## Bundled skills

Muon exposes selected roots through Pi resource discovery.

```text
skillsets/muon/
  using-muon
  yagni-scope-guard

skillsets/ponytail/
  ponytail
  ponytail-review
  ponytail-audit
  ponytail-debt
  ponytail-gain
  ponytail-help

skillsets/superpowers/
  using-superpowers
  brainstorming
  writing-plans
  executing-plans
  subagent-driven-development
  test-driven-development
  systematic-debugging
  verification-before-completion
  using-git-worktrees
  requesting-code-review
  receiving-code-review
  finishing-a-development-branch
  dispatching-parallel-agents
  writing-skills
```
