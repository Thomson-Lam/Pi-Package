# handoff extension

Minimal Pi extension that packages the bundled `handoff` skill and provides a UI-based `/hattach` command for attaching saved handoffs.

## Skill

Use the skill to create or update a repository handoff:

```text
/skill:handoff
/skill:handoff brief
/skill:handoff detailed
/skill:handoff repo
/skill:handoff global
```

The skill writes a local repo handoff by default:

```text
docs/handoff/handoff-<subject>.md
```

`<subject>` is a short semantic slug determined by the agent from the handoff content, for example `extension-refactor` or `release-status`.

The skill should also add `docs/handoff/` to `.gitignore`.

If explicitly requested, it can write a global handoff:

```text
~/.pi/agent/handoffs/<repo-slug>/handoff-<subject>.md
```

## Attach command

Use `/hattach` to attach an existing handoff through UI pickers:

```text
/hattach
/hattach help
/hattach attach local
/hattach attach global
```

- `/hattach` opens a modal menu with Help, Attach local, and Attach global.
- Modals support arrow keys plus `j/k` and `J/K` vim motions.
- Help is shown as a dismissible UI modal, not injected into agent chat context.
- `attach local` reads from `docs/handoff/handoff-*.md` under the current repository root.
- `attach global` lets you navigate all global repo handoffs under `~/.pi/agent/handoffs/<repo-slug>/handoff-*.md`.
- When multiple handoffs exist, a picker opens.
- The selected handoff is attached directly to the current session context with `triggerTurn: false`; it does not queue a future turn and does not start the agent.
