# Ctx extension index

Description: Context inspection UI, anchor jumps, and the prepared fresh-session workflow.

Components:
- `index.ts` — registers `/ctx`, `/cnew`, `/cb`, `/reads`, `/can`, `/cana`, `/canu` and wires collectors, fresh flow, and UI.
- `src/collector.ts` — session event hooks that capture read events and system prompt snapshots, and refresh the status widget.
- `src/reconstruct.ts` — builds context items from session state for the UI.
- `src/state.ts` — mutable inspector state (read events, filter, panel, last reconstruction).
- `src/anchors.ts` — anchor targets, jump locations, and latest-message labeling for `/can*`.
- `src/types.ts` — inspector and fresh-session types.
- `src/fresh/` — fresh-session flow: `transition.ts` orchestrates `/cnew`/`/cb`; `selection.ts`, `ledger.ts`, `files.ts`, `limits.ts`, and `context-message.ts` select, hash, size, and serialize files; `muon-build.ts` glues `/cb` to Muon build mode.
- `src/ui/` — inspector and fresh UIs: `panel.ts`, `context-usage-panel.ts`, `widget.ts`, `detail.ts`, `anchor-list.ts`, `fresh-review.ts`, `fresh-message.ts`, `model-thinking-selector.ts`.
- `package.json` — `pi-ctx` package manifest with its own test script.
- `tests/` — unit coverage for anchors, fresh flow, selection, ledger, limits, and rendering.

Related:
- `../../AGENTS.md`