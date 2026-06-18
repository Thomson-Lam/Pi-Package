# Token efficiency estimates for `/pr`

`/pr` asks the agent to produce compact review JSON and lets the local CLI validate, collect git metadata/diffs, escape content, style, and render HTML. This is usually more token-efficient than asking the agent to hand-generate the final HTML.

## Why JSON-to-CLI is cheaper than agent-authored HTML

The agent only writes semantic review content: title, summary, chapters, file purposes, risks, and validation notes. The CLI supplies repeated structure, HTML shell, CSS, badges, tables, provenance, escaping, and embedded diffs from local git state.

Approximate output-token comparison for a medium review:

| Approach | Agent-generated output tokens |
| --- | ---: |
| Compact JSON report | ~2k-6k tokens |
| Full styled HTML without raw diffs | ~8k-20k tokens |
| Full styled HTML with raw diffs embedded | ~20k-80k+ tokens |

For a typical medium artifact, JSON-to-CLI commonly saves about **10k-30k output tokens** on modest diffs, **50k+ output tokens** on larger diffs, or roughly **60-90% of generation tokens** compared with asking the agent to author the full HTML.

The main caveat is input/context cost: the agent still spends tokens on whatever `git diff` output it chooses to inspect. If it dumps a huge patch into context, those input tokens are still paid. The savings come from not making the model regenerate boilerplate HTML, CSS, provenance, and raw patch text.

## Tier tradeoffs

### `ultralow`

Most token-efficient tier.

- No scaffold file.
- Agent generates compact JSON directly in `render --stdin`.
- Rendered artifact omits raw diffs.
- Best for quick handoffs or “what changed?” summaries.

Tradeoff: minimal detail and less durable structure for deep review.

### `low`

Still highly efficient.

- No scaffold file.
- Agent generates compact JSON directly in `render --stdin`.
- Requires validation evidence or explicit missing-validation notes.
- Good for internal review handoffs where a concise artifact is enough.

Tradeoff: if validation fails, the agent usually regenerates the here-doc JSON rather than editing a saved draft.

### `medium`

Balanced default.

- Uses scaffolded JSON in `/tmp` so the agent starts from known-good structure and exact changed file paths.
- Agent fills placeholders, then `render` validates and generates HTML in one step.
- Good for shareable artifacts with clear chapters and enough validation context.

Tradeoff: more tool calls than low/ultralow, but fewer schema mistakes and less repair churn.

### `high`

Most expensive, intentionally.

- Uses scaffolded JSON for robust editing.
- Requires stronger file coverage, per-file focus, risks, decisions, limitations, and validation evidence.
- Best for risky changes: auth, permissions, migrations, payments, data deletion, shared middleware, schema changes, or broad refactors.

Tradeoff: higher token and time cost, but the extra structure is useful for serious review.

## Design Choice 

The workflow is intentionally split into simple responsibilities:

- Agent: semantic review judgment.
- CLI: schema validation, git metadata/diff collection, escaping, styling, and HTML rendering.
- Low/ultralow: direct stdin JSON for speed.
- Medium/high: scaffold first for reliability.

