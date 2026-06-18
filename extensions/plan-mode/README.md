# plan-mode extension

Scaffolded v1 extension layout for the global plan-mode workflow.

Deferred:

1. add docs/ + skilled module mode to facilitate better planning along with the /cindex skill
2. add plan templates and sources to import in addition to SuModules, and try out the templates
    1. Consider whether there is a need to make repo level plans to include as importable, or whether keeping this to extension scoped within the source code (import from data files in the source code repo) is good enough
    2. ideally, **parameterize** this and make it extensible!
3. add and test SuModules; check if deletion has been added
4. add indexes (no need for change, just trim current below)
5. understand how the code works - get a good understanding of how the Pi agent works technically!

## Files

- `index.ts` — extension entrypoint
- `commands.ts` — slash command registration
- `guardrails.ts` — plan-mode tool restrictions
- `prompt.ts` — plan-mode system prompt injection
- `prompts.json` — externalized prompt/resource strings
- `prompts.ts` — prompt config loader/template renderer
- `storage.ts` — global plan-store helpers
- `editor.ts` — tmux + nvim open flow
- `state.ts` / `types.ts` — session state + persistence

## Current scaffold status

Implemented:
- vim-style custom picker (`j/k` move, `l/enter` select, `h/esc` cancel, `s` search, `Shift+H` back from action menu) for list flows
- write/edit/bash guardrail hook
- minimal footer/widget status

Still to refine:
- better bash allowlist/parser
- optional autocomplete
- SuModule apply-to-plan insertion behavior
