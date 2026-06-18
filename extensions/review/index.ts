import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ReviewMode = "worktree" | "staged" | "baseRef";
type ReviewDetail = "ultralow" | "low" | "medium" | "high";
type ReviewDevDetail = ReviewDetail | "all";
type ReviewOut = "repo" | "localpi" | "global";

type ReviewCommandOptions = {
  mode: ReviewMode;
  base?: string;
  open: boolean;
  includeUntracked: boolean;
  targetCwd: string;
  detail: ReviewDetail;
  out: ReviewOut;
  userPrompt?: string;
};

type ReviewDevCommandOptions = {
  open: boolean;
  targetCwd: string;
  detail: ReviewDevDetail;
  out: ReviewOut;
  fixture: string;
  ignored: string[];
};

type ParsedReviewArgs = ReviewCommandOptions | { help: true } | string;
type ParsedReviewDevArgs = ReviewDevCommandOptions | { help: true } | string;

const here = dirname(fileURLToPath(import.meta.url));

export default function reviewExtension(pi: ExtensionAPI) {
  pi.registerCommand("pr-dev", {
    description: "Render dummy review HTML fixtures without invoking the agent",
    handler: async (args, ctx) => {
      const cliPath = resolve(here, "dist/bin/pi-review-artifact.js");
      const parsed = parseReviewDevArgs(args || "", ctx.hasUI, ctx.cwd);
      if (typeof parsed === "string") {
        ctx.ui.notify(parsed, "error");
        return;
      }
      if ("help" in parsed) {
        pi.sendMessage({ customType: "review-dev-help", content: reviewDevHelpText(cliPath, ctx.cwd), display: true });
        ctx.ui.notify("Displayed /pr-dev help.", "info");
        return;
      }

      const cliArgs = buildReviewDevCliArgs(cliPath, parsed);
      ctx.ui.notify(`Rendering dev review fixture (${parsed.detail}) for ${parsed.targetCwd}.`, "info");
      const result = await pi.exec("node", cliArgs, { timeout: 120_000 });
      const content = formatReviewDevResult({ cliPath, parsed, result });
      pi.sendMessage({ customType: "review-dev-result", content, display: true, details: { args: cliArgs, result } });
      if (result.code === 0) ctx.ui.notify("Rendered /pr-dev fixture artifact.", "info");
      else ctx.ui.notify("/pr-dev fixture render failed.", "error");
    },
  });

  pi.registerCommand("pr", {
    description: "Start a chapters-based code review artifact workflow for a target git diff",
    handler: async (args, ctx) => {
      const cliPath = resolve(here, "dist/bin/pi-review-artifact.js");
      const parsed = parseReviewArgs(args || "", ctx.hasUI, ctx.cwd);
      if (typeof parsed === "string") {
        ctx.ui.notify(parsed, "error");
        return;
      }
      if ("help" in parsed) {
        pi.sendMessage({ customType: "review-help", content: reviewHelpText(cliPath, ctx.cwd), display: true });
        ctx.ui.notify("Displayed /pr help.", "info");
        return;
      }

      const prompt = buildReviewPrompt(cliPath, parsed);
      ctx.ui.notify(`Starting /pr artifact workflow for ${parsed.targetCwd}.`, "info");
      if (ctx.isIdle()) pi.sendUserMessage(prompt);
      else pi.sendUserMessage(prompt, { deliverAs: "followUp" });
    },
  });
}

function parseReviewDevArgs(args: string, hasUI: boolean, defaultCwd: string): ParsedReviewDevArgs {
  const tokens = tokenizeArgs(args);
  if (tokens.includes("--help") || tokens.includes("-h") || tokens.includes("help")) return { help: true };

  let open = hasUI;
  let targetCwd: string | undefined;
  let detail: ReviewDevDetail = "all";
  let out: ReviewOut = "repo";
  let fixture = "comprehensive";
  const ignored: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "worktree" || token === "staged") {
      ignored.push(token);
      continue;
    }
    if (token === "baseRef") {
      ignored.push(token);
      const next = tokens[i + 1];
      if (next && !next.startsWith("--")) {
        ignored.push(next);
        i++;
      }
      continue;
    }
    if (token === "--base") {
      const next = tokens[i + 1];
      if (!next || next.startsWith("--")) return "Usage: /pr-dev --base <ref> (accepted for /pr compatibility but ignored by fixture rendering)";
      ignored.push(`${token} ${next}`);
      i++;
      continue;
    }
    if (token === "--cwd" || token === "--repo" || token === "--path") {
      const next = tokens[i + 1];
      if (!next || next.startsWith("--")) return "Usage: /pr-dev --cwd <path> [--detail ultralow|low|medium|high|all] [--out repo|localpi|global]";
      targetCwd = resolve(defaultCwd, next);
      i++;
      continue;
    }
    if (token.startsWith("--cwd=") || token.startsWith("--repo=") || token.startsWith("--path=")) {
      targetCwd = resolve(defaultCwd, token.slice(token.indexOf("=") + 1));
      continue;
    }
    if (token === "--fixture") {
      const next = tokens[i + 1];
      if (!next || next.startsWith("--")) return "Usage: /pr-dev --fixture comprehensive";
      fixture = next;
      i++;
      continue;
    }
    if (token.startsWith("--fixture=")) {
      fixture = token.slice("--fixture=".length);
      continue;
    }
    if (token === "--detail") {
      const next = tokens[i + 1];
      if (!next || next.startsWith("--")) return "Usage: /pr-dev --detail ultralow|low|medium|high|all";
      if (!isReviewDevDetail(next)) return `Unsupported --detail ${JSON.stringify(next)}. Use ultralow, low, medium, high, or all.`;
      detail = next;
      i++;
      continue;
    }
    if (token.startsWith("--detail=")) {
      const value = token.slice("--detail=".length);
      if (!isReviewDevDetail(value)) return `Unsupported --detail ${JSON.stringify(value)}. Use ultralow, low, medium, high, or all.`;
      detail = value;
      continue;
    }
    if (token === "--out") {
      const next = tokens[i + 1];
      if (!next || next.startsWith("--")) return "Usage: /pr-dev --out repo|localpi|global";
      if (!isReviewOut(next)) return `Unsupported --out ${JSON.stringify(next)}. Use repo, localpi, or global.`;
      out = next;
      i++;
      continue;
    }
    if (token.startsWith("--out=")) {
      const value = token.slice("--out=".length);
      if (!isReviewOut(value)) return `Unsupported --out ${JSON.stringify(value)}. Use repo, localpi, or global.`;
      out = value;
      continue;
    }
    if (token === "--open") {
      open = true;
      continue;
    }
    if (token === "--no-open") {
      open = false;
      continue;
    }
    if (token === "--include-untracked" || token === "--tracked-only" || token === "--no-include-untracked") {
      ignored.push(token);
      continue;
    }
    if (token.startsWith("--")) {
      return `Unknown /pr-dev option: ${token}. Run /pr-dev --help for usage.`;
    }
    if (!targetCwd) {
      targetCwd = resolve(defaultCwd, token);
      continue;
    }
    return `Unexpected /pr-dev argument: ${token}. Run /pr-dev --help for usage.`;
  }

  return { open, targetCwd: targetCwd || defaultCwd, detail, out, fixture, ignored };
}

function buildReviewDevCliArgs(cliPath: string, opts: ReviewDevCommandOptions): string[] {
  return [
    cliPath,
    "dev-render",
    "--fixture",
    opts.fixture,
    "--detail",
    opts.detail,
    "--cwd",
    opts.targetCwd,
    "--out",
    opts.out,
    opts.open ? "--open" : "--no-open",
  ];
}

function formatReviewDevResult(input: {
  cliPath: string;
  parsed: ReviewDevCommandOptions;
  result: Awaited<ReturnType<ExtensionAPI["exec"]>>;
}): string {
  const { cliPath, parsed, result } = input;
  const ignored = parsed.ignored.length ? `\n\nCompatibility note: ignored real-diff flag(s): ${parsed.ignored.join(", ")}. /pr-dev uses static fixtures and does not inspect git.` : "";
  const stderr = result.stderr?.trim() ? `\n\n## stderr\n\n\`\`\`text\n${result.stderr.trim()}\n\`\`\`` : "";
  const stdout = result.stdout?.trim() ? result.stdout.trim() : "No output.";
  return `# /pr-dev ${result.code === 0 ? "completed" : "failed"}

- CLI: ${cliPath}
- Fixture: ${parsed.fixture}
- Detail: ${parsed.detail}
- Target cwd: ${parsed.targetCwd}
- Output: ${outputLocationDescription(parsed.out)}
- Open: ${parsed.open ? "yes" : "no"}${ignored}

## CLI output

\`\`\`text
${stdout}
\`\`\`${stderr}`;
}

function parseReviewArgs(args: string, hasUI: boolean, defaultCwd: string): ParsedReviewArgs {
  const tokens = tokenizeArgs(args);
  if (tokens.includes("--help") || tokens.includes("-h") || tokens.includes("help")) return { help: true };

  let mode: ReviewMode = "worktree";
  let base: string | undefined;
  let open = hasUI;
  let includeUntracked: boolean | undefined;
  let targetCwd: string | undefined;
  let detail: ReviewDetail = "medium";
  let out: ReviewOut = "repo";
  const userPrompts: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "worktree" || token === "staged") {
      mode = token;
      continue;
    }
    if (token === "baseRef") {
      mode = "baseRef";
      const next = tokens[i + 1];
      if (next && !next.startsWith("--")) {
        base = next;
        i++;
      }
      continue;
    }
    if (token === "--base") {
      const next = tokens[i + 1];
      if (!next || next.startsWith("--")) return "Usage: /pr [path] baseRef <ref> or /pr [path] --base <ref>";
      base = next;
      mode = "baseRef";
      i++;
      continue;
    }
    if (token === "--cwd" || token === "--repo" || token === "--path") {
      const next = tokens[i + 1];
      if (!next || next.startsWith("--")) return `Usage: /pr --cwd <path> [worktree|staged|baseRef <ref>] [--detail ultralow|low|medium|high] [--out repo|localpi|global]`;
      targetCwd = resolve(defaultCwd, next);
      i++;
      continue;
    }
    if (token.startsWith("--cwd=")) {
      targetCwd = resolve(defaultCwd, token.slice("--cwd=".length));
      continue;
    }
    if (token.startsWith("--repo=") || token.startsWith("--path=")) {
      targetCwd = resolve(defaultCwd, token.slice(token.indexOf("=") + 1));
      continue;
    }
    if (token === "--detail") {
      const next = tokens[i + 1];
      if (!next || next.startsWith("--")) return "Usage: /pr --detail ultralow|low|medium|high";
      if (!isReviewDetail(next)) return `Unsupported --detail ${JSON.stringify(next)}. Use ultralow, low, medium, or high.`;
      detail = next;
      i++;
      continue;
    }
    if (token.startsWith("--detail=")) {
      const value = token.slice("--detail=".length);
      if (!isReviewDetail(value)) return `Unsupported --detail ${JSON.stringify(value)}. Use ultralow, low, medium, or high.`;
      detail = value;
      continue;
    }
    if (token === "--out") {
      const next = tokens[i + 1];
      if (!next || next.startsWith("--")) return "Usage: /pr --out repo|localpi|global";
      if (!isReviewOut(next)) return `Unsupported --out ${JSON.stringify(next)}. Use repo, localpi, or global.`;
      out = next;
      i++;
      continue;
    }
    if (token.startsWith("--out=")) {
      const value = token.slice("--out=".length);
      if (!isReviewOut(value)) return `Unsupported --out ${JSON.stringify(value)}. Use repo, localpi, or global.`;
      out = value;
      continue;
    }
    if (token === "--open") {
      open = true;
      continue;
    }
    if (token === "--no-open") {
      open = false;
      continue;
    }
    if (token === "--include-untracked") {
      includeUntracked = true;
      continue;
    }
    if (token === "--tracked-only" || token === "--no-include-untracked") {
      includeUntracked = false;
      continue;
    }
    if (token === "--prompt") {
      const next = tokens[i + 1];
      if (!next || next.startsWith("--")) return "Usage: /pr --prompt <instructions>";
      userPrompts.push(next);
      i++;
      continue;
    }
    if (token.startsWith("--prompt=")) {
      const value = token.slice("--prompt=".length).trim();
      if (!value) return "Usage: /pr --prompt <instructions>";
      userPrompts.push(value);
      continue;
    }
    if (token.startsWith("--")) {
      return `Unknown /pr option: ${token}. Run /pr --help for usage.`;
    }
    if (!targetCwd) {
      targetCwd = resolve(defaultCwd, token);
      continue;
    }
    return `Unexpected /pr argument: ${token}. Run /pr --help for usage.`;
  }

  if (mode === "baseRef" && !base) return "Usage: /pr [path] baseRef <ref> [--detail ultralow|low|medium|high] [--out repo|localpi|global] [--open|--no-open] [--include-untracked] [--prompt <instructions>]";
  return {
    mode,
    base,
    open,
    includeUntracked: includeUntracked ?? mode === "worktree",
    targetCwd: targetCwd || defaultCwd,
    detail,
    out,
    userPrompt: userPrompts.length ? userPrompts.join("\n\n") : undefined,
  };
}

function buildReviewPrompt(cliPath: string, opts: ReviewCommandOptions): string {
  const cli = shellQuote(cliPath);
  const cwdArg = shellQuote(opts.targetCwd);
  const modeArgs = opts.mode === "baseRef" ? `--mode baseRef --base ${shellQuote(opts.base || "HEAD")}` : `--mode ${opts.mode}`;
  const untrackedArg = opts.includeUntracked ? " --include-untracked" : "";
  const openArg = opts.open ? "--open" : "--no-open";
  const outArg = `--out ${opts.out}`;
  const renderArgs = `--template chapters --cwd ${cwdArg} ${modeArgs}${untrackedArg} --detail ${opts.detail} ${outArg} ${openArg}`;
  const diffArgs = opts.mode === "staged" ? "diff --cached" : opts.mode === "baseRef" ? `diff ${shellQuote(opts.base || "HEAD")}` : "diff HEAD";

  if (opts.detail === "ultralow" || opts.detail === "low") return buildEphemeralReviewPrompt({ cliPath, cli, cwdArg, opts, renderArgs, diffArgs });
  return buildScaffoldReviewPrompt({ cliPath, cli, cwdArg, opts, renderArgs, diffArgs });
}

function buildScaffoldReviewPrompt(input: { cliPath: string; cli: string; cwdArg: string; opts: ReviewCommandOptions; renderArgs: string; diffArgs: string }): string {
  const { cliPath, cli, cwdArg, opts, renderArgs, diffArgs } = input;
  const reportPath = `/tmp/pi-review-report-${Date.now()}.json`;
  const inputArg = shellQuote(reportPath);
  const scaffoldCommand = `node ${cli} scaffold --template chapters --cwd ${cwdArg} ${renderModeArgs(opts)}${opts.includeUntracked ? " --include-untracked" : ""} --detail ${opts.detail} --output ${inputArg}`;
  const renderCommand = `node ${cli} render --input ${inputArg} ${renderArgs}`;

  return `${commonReviewHeader(cliPath, opts)}

Workflow requirements:
1. Run the scaffold command exactly. It writes a draft JSON report containing all changed file paths and TODO_REPLACE placeholders.
2. Inspect the final diff in ${opts.targetCwd} using Bash/Git. Use the scaffold only as structure; do not trust placeholders as content.
3. Fill the scaffold JSON at ${reportPath}. Replace every TODO_REPLACE placeholder. Do not include HTML, Mermaid, or raw diffs in the JSON. Do not invent test outcomes.
4. Render with the chapters template. Render performs schema validation, placeholder rejection, detail-profile validation, git metadata collection, and HTML generation in one step. If render fails, fix the JSON and rerun render.
5. Return the final Artifact path plus a concise reviewer summary.

Run scaffold first:
\`\`\`bash
${scaffoldCommand}
\`\`\`

Suggested Git inspection commands:
\`\`\`bash
git -C ${cwdArg} status --short
git -C ${cwdArg} ${diffArgs} --stat
git -C ${cwdArg} ${diffArgs} --name-status --find-renames
# Inspect file-level patches as needed:
git -C ${cwdArg} ${diffArgs} -- <path>
\`\`\`

Then run render exactly after filling the report:
\`\`\`bash
${renderCommand}
\`\`\`

Only if you are unsure about the schema shape, run these fallback references:
\`\`\`bash
node ${cli} guide --template chapters
node ${cli} example --template chapters
\`\`\`
`;
}

function buildEphemeralReviewPrompt(input: { cliPath: string; cli: string; cwdArg: string; opts: ReviewCommandOptions; renderArgs: string; diffArgs: string }): string {
  const { cliPath, cli, cwdArg, opts, renderArgs, diffArgs } = input;
  const renderCommandPrefix = `node ${cli} render --stdin ${renderArgs}`;

  return `${commonReviewHeader(cliPath, opts)}

Workflow requirements for ${opts.detail} detail:
1. Do not run scaffold and do not write a report JSON file to /tmp.
2. Inspect the final diff in ${opts.targetCwd} using Bash/Git.
3. Generate compact report JSON directly in the render command here-doc. Do not include HTML, Mermaid, or raw diffs in the JSON. Do not invent test outcomes.
4. Render with the chapters template. Render performs schema validation, placeholder rejection, detail-profile validation, git metadata collection, and HTML generation in one step. If render fails, fix the here-doc JSON and rerun render.
5. Return the final Artifact path plus a concise reviewer summary.

Suggested Git inspection commands:
\`\`\`bash
git -C ${cwdArg} status --short
git -C ${cwdArg} ${diffArgs} --stat
git -C ${cwdArg} ${diffArgs} --name-status --find-renames
# Inspect file-level patches as needed:
git -C ${cwdArg} ${diffArgs} -- <path>
\`\`\`

Use this JSON shape for the here-doc. Keep it concise and replace all example text:
\`\`\`json
${ephemeralJsonShape(opts.detail)}
\`\`\`

Run render with stdin after inspecting the diff:
\`\`\`bash
${renderCommandPrefix} <<'PI_REVIEW_JSON'
{
  "schemaVersion": "1.0",
  "reviewDetail": "${opts.detail}",
  "title": "Concise review title",
  "summary": {
    "intent": "What this diff is trying to accomplish.",
    "changeType": "mixed"
  },
  "changes": [
    {
      "title": "Review target changes",
      "summary": "Brief summary of the changed area.",
      "files": [
        { "path": "path/from/git-diff", "purpose": "Why this file changed." }
      ]
    }
  ],
  "chapters": [
    {
      "sequence": 1,
      "title": "Review target changes",
      "summary": "Brief reviewer-facing summary.",
      "files": [
        { "path": "path/from/git-diff", "purpose": "Why this file changed." }
      ]
    }
  ]${opts.detail === "low" ? `,
  "validation": { "runs": [] },
  "missingValidation": ["State checks not run, or use an empty array if none are missing."]` : ""}
}
PI_REVIEW_JSON
\`\`\`

Only if you are unsure about the schema shape, run these fallback references:
\`\`\`bash
node ${cli} guide --template chapters
node ${cli} example --template chapters
\`\`\`
`;
}

function commonReviewHeader(cliPath: string, opts: ReviewCommandOptions): string {
  return `Create a chapters-based code review artifact for the final requested diff.

Use this exact local CLI; do not assume pi-review-artifact is on PATH:
- CLI path: ${cliPath}
- Target cwd: ${opts.targetCwd}
- Template: chapters
- Diff mode: ${opts.mode}${opts.base ? ` (${opts.base})` : ""}
- Include untracked files: ${opts.includeUntracked ? "yes" : "no"}
- Review detail: ${opts.detail}
- Output location: ${outputLocationDescription(opts.out)}
- Open artifact after render: ${opts.open ? "yes" : "no"}${userPromptInstructions(opts)}

Detail tier expectations:
${detailInstructions(opts.detail)}`;
}

function userPromptInstructions(opts: ReviewCommandOptions): string {
  const prompt = opts.userPrompt?.trim();
  if (!prompt) return "";
  return `

Additional user review instructions:
${prompt}

Apply these additional instructions as review emphasis unless they conflict with the required workflow, schema, CLI commands, git evidence, or validation rules above.`;
}

function renderModeArgs(opts: ReviewCommandOptions): string {
  return opts.mode === "baseRef" ? `--mode baseRef --base ${shellQuote(opts.base || "HEAD")}` : `--mode ${opts.mode}`;
}

function ephemeralJsonShape(detail: ReviewDetail): string {
  const validation = detail === "low" ? `,\n  "validation": { "runs": [] },\n  "missingValidation": ["Checks not run, or [] if none"]` : "";
  return `{\n  "schemaVersion": "1.0",\n  "reviewDetail": "${detail}",\n  "title": "...",\n  "summary": { "intent": "...", "changeType": "mixed" },\n  "changes": [{ "title": "...", "summary": "...", "files": [{ "path": "...", "purpose": "..." }] }],\n  "chapters": [{ "sequence": 1, "title": "...", "summary": "...", "files": [{ "path": "...", "purpose": "..." }] }]${validation}\n}`;
}

function detailInstructions(detail: ReviewDetail): string {
  if (detail === "ultralow") {
    return `- Ultralow: fastest compact handoff. Use one broad group/chapter, file purposes, minimal validation notes, and no raw diffs in the rendered artifact.`;
  }
  if (detail === "low") {
    return `- Low: concise internal handoff. Prefer 1-3 chapters, brief summaries, file purposes, validation/missingValidation, and only critical risks.`;
  }
  if (detail === "high") {
    return `- High: rigorous review artifact. Cover every changed file, use explicit reviewer order, add per-file purpose/focus/risk where useful, include risks with mitigation, decisions/alternatives, behaviorFlow for behavior changes, knownLimitations, and detailed validation evidence.`;
  }
  return `- Medium: shareable coherent artifact. Prefer 3-6 chapters, assign all changed files where possible, include chapter summaries, file purposes, chapter-level reviewFocus, validation/missingValidation, and relevant risks/decisions/knownLimitations.`;
}

function reviewDevHelpText(cliPath: string, currentCwd: string): string {
  return `# /pr-dev help

Render dummy chapters-based review HTML fixtures from inside Pi without invoking the agent.

## Quick start

\`/pr-dev [path] [--fixture comprehensive] [--detail ultralow|low|medium|high|all] [--out repo|localpi|global] [--open|--no-open]\`

If \`path\` is omitted, /pr-dev uses the current Pi cwd: \`${currentCwd}\`.

## Common examples

- \`/pr-dev\` — render all dummy detail-tier artifacts using the current cwd and default output behavior.
- \`/pr-dev --detail all --out localpi --no-open\` — render all fixture artifacts under \`.pi/reviews/dev/\` without opening a browser.
- \`/pr-dev --detail high --out repo --open\` — render only the high-detail fixture and open it.
- \`/pr-dev --cwd agent/extensions/review --detail medium --out global\` — write a medium fixture artifact under \`~/.pi/agent/reviews/dev/\`.

## What /pr-dev does

- Runs the local CLI command \`dev-render\` using \`pi.exec\`.
- Loads static dummy review JSON and a static dummy GitSnapshot fixture.
- Calls the same chapters HTML renderer used by production review artifacts.
- Does not call \`pi.sendUserMessage\`.
- Does not start an agent turn.
- Does not inspect real git state.
- Does not generate JSON with a model.

## Supported flags

- Path targeting: positional path, \`--cwd <path>\`, \`--repo <path>\`, \`--path <path>\`.
- Fixture: \`--fixture comprehensive\`.
- Detail: \`--detail ultralow\`, \`--detail low\`, \`--detail medium\`, \`--detail high\`, or \`--detail all\`.
- Output: \`--out repo\`, \`--out localpi\`, \`--out global\`.
- Open control: \`--open\`, \`--no-open\`.

For easier switching between \`/pr\` and \`/pr-dev\`, real-diff flags like \`worktree\`, \`staged\`, \`baseRef <ref>\`, \`--base <ref>\`, and \`--include-untracked\` are accepted but ignored.

## Direct CLI fallback

CLI path for this extension:
\`${cliPath}\`

Example direct command:
\`\`\`bash
node '${cliPath}' dev-render --fixture comprehensive --detail all --cwd '${currentCwd}' --out localpi --no-open
\`\`\`
`;
}

function reviewHelpText(cliPath: string, currentCwd: string): string {
  return `# /pr help

Create a shareable chapters-based code review artifact from compact JSON plus authoritative local git diffs.

## Quick start

\`/pr [path] [worktree|staged|baseRef <ref>] [--detail ultralow|low|medium|high] [--out repo|localpi|global] [--open|--no-open] [--include-untracked] [--prompt <instructions>]\`

If \`path\` is omitted, /pr uses the current Pi cwd: \`${currentCwd}\`.

## Common examples

- \`/pr\` — review current cwd worktree, include untracked files, medium detail, write the HTML directly in the target git repo root.
- \`/pr agent/extensions/review\` — review a nested repo/directory and write to that repo root.
- \`/pr --cwd agent/extensions/review --detail high\` — rigorous artifact for a target path.
- \`/pr agent/extensions/review staged --detail low --no-open\` — compact staged-only artifact.
- \`/pr agent/extensions/review --detail low --out localpi\` — write to the target repo's local Pi store at .pi/reviews/.
- \`/pr agent/extensions/review baseRef main --detail medium --out global\` — compare target path against main and write to ~/.pi/agent/reviews/.
- \`/pr --detail high --prompt "Focus especially on API compatibility and migration risks."\` — add custom review emphasis to the generated workflow prompt.

## Path targeting and options

- Positional path: \`/pr path/to/repo\`.
- Explicit path: \`/pr --cwd path/to/repo\`, \`/pr --cwd=path/to/repo\`.
- Aliases: \`--repo\`, \`--repo=...\`, \`--path\`, \`--path=...\`.
- Output control: \`--out repo\` (default, writes the HTML file directly in the target git repo root), \`--out localpi\` (writes to \`.pi/reviews/\` under the target git root), \`--out global\` (writes to \`~/.pi/agent/reviews/\`). Explicit CLI \`--output <file>\` overrides \`--out\`.
- Open control: \`--open\`, \`--no-open\`.
- Untracked control: \`--include-untracked\`, \`--tracked-only\`, \`--no-include-untracked\`.
- Detail control: \`--detail ultralow\`, \`--detail low\`, \`--detail=medium\`, \`--detail high\`.
- Additional prompt: \`--prompt "Focus on security boundaries"\` or \`--prompt=...\`. Repeat \`--prompt\` to append multiple instruction blocks.
- Help: \`/pr --help\`, \`/pr -h\`, or \`/pr help\`.

## Diff modes

- \`worktree\` — default; compares against HEAD. Includes untracked files by default for /pr.
- \`staged\` — uses \`git diff --cached\`; untracked files are excluded unless explicitly included.
- \`baseRef <ref>\` — compares against an explicit base ref and requires the ref argument.

## Detail tiers

- \`--detail ultralow\` — fastest compact handoff: one broad grouping, minimal fields, raw diffs omitted from the artifact. Uses direct stdin JSON; no /tmp report.
- \`--detail low\` — compact internal handoff: 1-3 chapters, minimal optional fields. Uses direct stdin JSON; no /tmp report.
- \`--detail medium\` — default shareable artifact: 3-6 chapters, validation, relevant risks/decisions. Uses scaffolded /tmp JSON for robust editing.
- \`--detail high\` — rigorous review: exhaustive file coverage, per-file focus/risk where useful, decisions, behavior flow, limitations, detailed validation evidence. Uses scaffolded /tmp JSON for robust editing.

## What the agent will do

- Low/ultralow: inspect git, generate compact JSON in a render stdin here-doc, and render in one CLI step.
- Medium/high: scaffold a JSON draft, fill it, then render. Render performs validation and HTML generation in one step.

## Direct CLI fallback

CLI path for this extension:
\`${cliPath}\`

Example direct commands:
\`\`\`bash
node '${cliPath}' scaffold --template chapters --cwd '${currentCwd}' --mode worktree --include-untracked --detail medium --output /tmp/pi-review-report.json
node '${cliPath}' render --input /tmp/pi-review-report.json --template chapters --cwd '${currentCwd}' --mode worktree --include-untracked --detail medium --out repo --no-open
node '${cliPath}' render --stdin --template chapters --cwd '${currentCwd}' --mode worktree --include-untracked --detail low --out localpi --no-open <<'JSON'
{"schemaVersion":"1.0","reviewDetail":"low","title":"Example","summary":{"intent":"Example.","changeType":"mixed"},"changes":[{"title":"Changes","summary":"Example.","files":[{"path":"file.ts","purpose":"Example."}]}],"chapters":[{"sequence":1,"title":"Changes","summary":"Example.","files":[{"path":"file.ts","purpose":"Example."}]}],"validation":{"runs":[]},"missingValidation":["Example only."]}
JSON
# omit --out or pass --out repo to write directly in the target git root; use --out localpi for .pi/reviews/ or --out global for ~/.pi/agent/reviews/.
\`\`\`

## Cheap development fixture rendering

Use \`/pr-dev --detail all --out localpi --no-open\` to render static dummy HTML artifacts through the same chapters renderer without invoking the agent or reading real git state.

## Troubleshooting

- If render says \`not a git repository\`, pass a repo path: \`/pr --cwd path/to/repo\`.
- If validation reports unresolved placeholders, edit the scaffold JSON or stdin JSON and replace every \`TODO_REPLACE\` string.
- If the artifact omits new files, rerun with \`--include-untracked\` or ensure files are staged/tracked.
`;
}

function tokenizeArgs(input: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) quote = undefined;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        out.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current) out.push(current);
  return out;
}

function isReviewDetail(value: string): value is ReviewDetail {
  return value === "ultralow" || value === "low" || value === "medium" || value === "high";
}

function isReviewDevDetail(value: string): value is ReviewDevDetail {
  return value === "all" || isReviewDetail(value);
}

function outputLocationDescription(out: ReviewOut): string {
  if (out === "global") return "global (~/.pi/agent/reviews/)";
  if (out === "localpi") return "local Pi store (.pi/reviews/ under the git root)";
  return "repo root (the target git repository root)";
}

function isReviewOut(value: string): value is ReviewOut {
  return value === "repo" || value === "localpi" || value === "global";
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
