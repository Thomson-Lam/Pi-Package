# Pi-telescope extension index

Description: Fuzzy finder UI with providers for files, sessions, skills, commands, and git, plus frecency ranking.

Components:
- `index.ts` — registers `/telescope` and `/ts`, `@` file completion, and keybindings (Ctrl+Alt+F/S/K/C/D/B/L/T/U/A/X/Z).
- `telescope.ts` — finder UI: split panel, multi-select, provider switching, preview, and help.
- `scoring.ts` — fzf-style fuzzy scoring with pattern modifiers (`'exact, ^prefix, suffix$, !negate`).
- `frecency.ts` — frequency + recency ranking of past selections.
- `providers/` — files, git-branches, git-log, sessions, skills, muon-skills, commands, hotkeys, session-tree.
- `preview.ts` — file preview formatting with syntax highlighting.
- `clipboard.ts` — cross-platform clipboard copy.
- `response-editor.ts` — response editing via an external editor.
- `session-tree.ts` — session tree model for tree providers.
- `types.ts` — provider interface types.
- `tests/` — smoke coverage for hotkeys, sessions, and skills, plus tests for session-tree and response-editor.

Related:
- `../../AGENTS.md`