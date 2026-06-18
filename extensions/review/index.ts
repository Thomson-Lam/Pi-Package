import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, SelectList, Text } from "@earendil-works/pi-tui";

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
  projectCwd: string;
  detail: ReviewDetail;
  out: ReviewOut;
  userPrompt?: string;
};

type ReviewDevCommandOptions = {
  open: boolean;
  targetCwd: string;
  projectCwd: string;
  detail: ReviewDevDetail;
  out: ReviewOut;
  fixture: string;
  ignored: string[];
};

const here = dirname(fileURLToPath(import.meta.url));
const BACK = Symbol("review-wizard-back");
type Back = typeof BACK;

function isBack(value: unknown): value is Back {
  return value === BACK;
}

async function pickReviewOptions(ctx: ExtensionCommandContext, cliPath: string): Promise<ReviewCommandOptions | undefined> {
  let step = 0;
  let targetCwd = ctx.cwd;
  let mode: ReviewMode = "worktree";
  let base: string | undefined;
  let includeUntracked = true;
  let detail: ReviewDetail = "medium";
  let out: ReviewOut = "repo";
  let open = ctx.hasUI;
  let userPrompt: string | undefined;

  while (step >= 0 && step < 7) {
    if (step === 0) {
      const selected = await pickReviewTargetCwd(ctx, cliPath);
      if (isBack(selected)) continue;
      if (!selected) return undefined;
      targetCwd = selected;
      step++;
      continue;
    }

    if (step === 1) {
      const selected = await selectModal<ReviewMode>(ctx, "Diff to review", [
        { value: "worktree", label: "Worktree changes", description: "Compare against HEAD and include untracked files by default" },
        { value: "staged", label: "Staged changes", description: "Review only git diff --cached" },
        { value: "baseRef", label: "Compare with base ref", description: "Compare the target against a branch, tag, or commit" },
      ]);
      if (isBack(selected)) { step--; continue; }
      if (!selected) return undefined;
      mode = selected;
      base = undefined;
      includeUntracked = mode === "worktree";
      step = mode === "baseRef" ? 2 : mode === "worktree" ? 3 : 4;
      continue;
    }

    if (step === 2) {
      const selected = await editorModal(ctx, "Base ref", base || "HEAD");
      if (selected === undefined) return undefined;
      base = selected.trim() || "HEAD";
      step = 4;
      continue;
    }

    if (step === 3) {
      const selected = await selectModal<boolean>(ctx, "Include untracked files?", [
        { value: true, label: "Yes", description: "Recommended for worktree reviews" },
        { value: false, label: "No", description: "Only tracked files in the git diff" },
      ]);
      if (isBack(selected)) { step = 1; continue; }
      if (selected === undefined) return undefined;
      includeUntracked = selected;
      step = 4;
      continue;
    }

    if (step === 4) {
      const selected = await selectModal<ReviewDetail>(ctx, "Review depth", [
        { value: "medium", label: "Medium", description: "Default shareable codebase map with workflows and snippets" },
        { value: "low", label: "Low", description: "Compact internal handoff" },
        { value: "ultralow", label: "Ultralow", description: "Fastest minimal artifact" },
        { value: "high", label: "High", description: "Rigorous, exhaustive review artifact" },
      ]);
      if (isBack(selected)) { step = mode === "worktree" ? 3 : mode === "baseRef" ? 2 : 1; continue; }
      if (!selected) return undefined;
      detail = selected;
      step = 5;
      continue;
    }

    if (step === 5) {
      const selected = await selectModal<ReviewOut>(ctx, "Where should the artifact be written?", [
        { value: "repo", label: "Repo HTML reviews", description: "Write under html-reviews/ in the target git repository root" },
        { value: "localpi", label: "Local Pi store", description: "Write under .pi/reviews/ in the target repo" },
        { value: "global", label: "Global Pi store", description: "Write under ~/.pi/agent/reviews/<project-slug>/" },
      ]);
      if (isBack(selected)) { step = 4; continue; }
      if (!selected) return undefined;
      out = selected;
      step = 6;
      continue;
    }

    if (step === 6) {
      const selected = ctx.hasUI
        ? await selectModal<boolean>(ctx, "Open artifact after render?", [
            { value: true, label: "Yes", description: "Open the generated HTML when rendering completes" },
            { value: false, label: "No", description: "Only print the artifact path" },
          ])
        : false;
      if (isBack(selected)) { step = 5; continue; }
      if (selected === undefined) return undefined;
      open = selected;

      const addPrompt = await selectModal<boolean>(ctx, "Add review emphasis?", [
        { value: false, label: "No", description: "Use the standard review guidance" },
        { value: true, label: "Yes", description: "Add a short custom focus, e.g. security or API compatibility" },
      ]);
      if (isBack(addPrompt)) { step = 6; continue; }
      if (addPrompt === undefined) return undefined;
      userPrompt = addPrompt ? await inputModal(ctx, "Review emphasis", userPrompt || "Focus especially on...") : undefined;
      if (addPrompt && !userPrompt?.trim()) return undefined;
      step = 7;
    }
  }

  return { mode, base: base || (mode === "baseRef" ? "HEAD" : undefined), open, includeUntracked, targetCwd, projectCwd: ctx.cwd, detail, out, userPrompt: userPrompt?.trim() || undefined };
}

async function pickReviewDevOptions(ctx: ExtensionCommandContext, cliPath: string): Promise<ReviewDevCommandOptions | undefined> {
  let step = 0;
  let targetCwd = ctx.cwd;
  let detail: ReviewDevDetail = "all";
  let out: ReviewOut = "repo";
  let open = ctx.hasUI;

  while (step >= 0 && step < 4) {
    if (step === 0) {
      const selected = await pickReviewDevTargetCwd(ctx, cliPath);
      if (isBack(selected)) continue;
      if (!selected) return undefined;
      targetCwd = selected;
      step++;
      continue;
    }

    if (step === 1) {
      const selected = await selectModal<ReviewDevDetail>(ctx, "Fixture detail", [
        { value: "all", label: "All detail tiers", description: "Render ultralow, low, medium, and high fixtures" },
        { value: "medium", label: "Medium", description: "Default shareable fixture" },
        { value: "low", label: "Low", description: "Compact fixture" },
        { value: "ultralow", label: "Ultralow", description: "Smallest fixture" },
        { value: "high", label: "High", description: "Rigorous fixture" },
      ]);
      if (isBack(selected)) { step--; continue; }
      if (!selected) return undefined;
      detail = selected;
      step++;
      continue;
    }

    if (step === 2) {
      const selected = await selectModal<ReviewOut>(ctx, "Where should fixture artifacts be written?", [
        { value: "repo", label: "Repo HTML reviews", description: "Write under html-reviews/dev/ in the target git repository root" },
        { value: "localpi", label: "Local Pi store", description: "Write under .pi/reviews/dev/ in the target repo" },
        { value: "global", label: "Global Pi store", description: "Write under ~/.pi/agent/reviews/<project-slug>/dev/" },
      ]);
      if (isBack(selected)) { step--; continue; }
      if (!selected) return undefined;
      out = selected;
      step++;
      continue;
    }

    if (step === 3) {
      const selected = ctx.hasUI
        ? await selectModal<boolean>(ctx, "Open fixture artifact(s)?", [
            { value: true, label: "Yes", description: "Open after rendering" },
            { value: false, label: "No", description: "Only print paths" },
          ])
        : false;
      if (isBack(selected)) { step--; continue; }
      if (selected === undefined) return undefined;
      open = selected;
      step++;
    }
  }

  return { open, targetCwd, projectCwd: ctx.cwd, detail, out, fixture: "comprehensive", ignored: [] };
}

async function pickReviewTargetCwd(ctx: ExtensionCommandContext, cliPath: string): Promise<string | undefined | Back> {
  return pickHelpTargetCwd(ctx, "Review target", "Help", "Show /pr help without adding it to the chat context", "Review Artifact Help", reviewHelpText(cliPath, ctx.cwd));
}

async function pickReviewDevTargetCwd(ctx: ExtensionCommandContext, cliPath: string): Promise<string | undefined | Back> {
  return pickHelpTargetCwd(ctx, "Fixture target cwd", "Help", "Show /pr-dev help without adding it to the chat context", "Review Fixture Help", reviewDevHelpText(cliPath, ctx.cwd));
}

async function pickHelpTargetCwd(
  ctx: ExtensionCommandContext,
  title: string,
  helpLabel: string,
  helpDescription: string,
  helpTitle: string,
  helpMarkdown: string,
): Promise<string | undefined | Back> {
  while (true) {
    const choice = await selectModal<"current" | "custom" | "help">(ctx, title, [
      { value: "current", label: "Current Pi cwd", description: ctx.cwd },
      { value: "custom", label: "Choose another path", description: "Enter a repo or subdirectory path" },
      { value: "help", label: helpLabel, description: helpDescription },
    ]);
    if (isBack(choice)) continue;
    if (!choice) return undefined;
    if (choice === "help") {
      await showReviewHelp(ctx, helpTitle, helpMarkdown);
      continue;
    }
    if (choice === "current") return ctx.cwd;
    const value = await inputModal(ctx, "Target path", ctx.cwd);
    return value?.trim() ? resolve(ctx.cwd, value.trim()) : undefined;
  }
}

async function selectModal<T>(ctx: ExtensionCommandContext, title: string, items: Array<{ value: T; label: string; description?: string }>): Promise<T | undefined | Back> {
  const result = await ctx.ui.custom<T | undefined | Back>((tui, theme, _keybindings, done) => {
    const container = new Container();
    const selectItems = items.map((item, index) => ({ value: String(index), label: item.label, description: item.description }));
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
    const selectList = new SelectList(selectItems, Math.min(items.length, 10), {
      selectedPrefix: (text: string) => theme.fg("accent", text),
      selectedText: (text: string) => theme.fg("accent", text),
      description: (text: string) => theme.fg("muted", text),
      scrollInfo: (text: string) => theme.fg("dim", text),
      noMatch: (text: string) => theme.fg("warning", text),
    });
    selectList.onSelect = (item) => done(items[Number(item.value)]?.value);
    selectList.onCancel = () => done(undefined);
    container.addChild(selectList);
    container.addChild(new Text(theme.fg("dim", "↑↓/j/k navigate • enter select • h back • esc cancel"), 1, 0));
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        if (data === "h") done(BACK);
        else if (data === "j" || data === "J") selectList.handleInput("\x1b[B");
        else if (data === "k" || data === "K") selectList.handleInput("\x1b[A");
        else selectList.handleInput(data);
        tui.requestRender();
      },
    };
  });
  return result;
}

async function inputModal(ctx: ExtensionCommandContext, title: string, placeholder: string): Promise<string | undefined> {
  return ctx.ui.input(title, placeholder);
}

async function editorModal(ctx: ExtensionCommandContext, title: string, initialText: string): Promise<string | undefined> {
  return ctx.ui.editor(title, initialText);
}

async function showReviewHelp(ctx: ExtensionCommandContext, title: string, markdown: string): Promise<void | Back> {
  return ctx.ui.custom<void | Back>((tui, theme, _keybindings, done) => {
    let scroll = 0;
    const pageSize = 28;
    const mdTheme = getMarkdownTheme();
    const renderPage = (width: number): string[] => {
      const innerWidth = Math.max(10, width - 2);
      const border = (text: string) => theme.fg("borderAccent", text);
      const top = border(`┌${"─".repeat(innerWidth)}┐`);
      const bottom = border(`└${"─".repeat(innerWidth)}┘`);
      const wrapBorder = (line: string) => border("│") + padAnsi(line, innerWidth) + border("│");

      const bodyLines = new Markdown(markdown, 1, 1, mdTheme).render(innerWidth);
      const maxScroll = Math.max(0, bodyLines.length - pageSize);
      scroll = Math.min(maxScroll, Math.max(0, scroll));
      const visibleBody = bodyLines.slice(scroll, scroll + pageSize);
      const footer = theme.fg("dim", `j/k scroll • page up/down • showing ${scroll + 1}-${Math.min(bodyLines.length, scroll + pageSize)} of ${bodyLines.length} • h back • enter/esc close`);

      return [
        top,
        wrapBorder(theme.fg("accent", theme.bold(title))),
        ...visibleBody.map(wrapBorder),
        wrapBorder(footer),
        bottom,
      ];
    };
    return {
      render: renderPage,
      invalidate: () => undefined,
      handleInput: (data: string) => {
        if (data === "h") done(BACK);
        else if (data === "\r" || data === "\n" || data === "\x1b" || data === "\u0003") done();
        else if (data === "j" || data === "J" || data === "\x1b[B") scroll += 1;
        else if (data === "k" || data === "K" || data === "\x1b[A") scroll -= 1;
        else if (data === "\x1b[6~") scroll += pageSize;
        else if (data === "\x1b[5~") scroll -= pageSize;
        tui.requestRender();
      },
    };
  }, { overlay: true, overlayOptions: { width: "84%", minWidth: 60, maxHeight: "86%", margin: 2 } });
}

export default function reviewExtension(pi: ExtensionAPI) {
  pi.registerCommand("pr-dev", {
    description: "Open the review fixture renderer wizard",
    handler: async (args, ctx) => {
      const cliPath = resolve(here, "dist/bin/pi-review-artifact.js");
      if ((args || "").trim()) ctx.ui.notify("/pr-dev is now guided. Opening the fixture wizard instead of parsing arguments.", "info");

      const parsed = await pickReviewDevOptions(ctx, cliPath);
      if (!parsed) return;

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
    description: "Open the code review artifact wizard",
    handler: async (args, ctx) => {
      const cliPath = resolve(here, "dist/bin/pi-review-artifact.js");
      if ((args || "").trim()) ctx.ui.notify("/pr is now guided. Opening the review wizard instead of parsing arguments.", "info");

      const parsed = await pickReviewOptions(ctx, cliPath);
      if (!parsed) return;

      const prompt = buildReviewPrompt(cliPath, parsed);
      ctx.ui.notify(`Starting /pr artifact workflow for ${parsed.targetCwd}.`, "info");
      if (ctx.isIdle()) pi.sendUserMessage(prompt);
      else pi.sendUserMessage(prompt, { deliverAs: "followUp" });
    },
  });
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
    "--project-cwd",
    opts.projectCwd,
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

function buildReviewPrompt(cliPath: string, opts: ReviewCommandOptions): string {
  const cli = shellQuote(cliPath);
  const cwdArg = shellQuote(opts.targetCwd);
  const modeArgs = opts.mode === "baseRef" ? `--mode baseRef --base ${shellQuote(opts.base || "HEAD")}` : `--mode ${opts.mode}`;
  const untrackedArg = opts.includeUntracked ? " --include-untracked" : "";
  const openArg = opts.open ? "--open" : "--no-open";
  const outArg = `--out ${opts.out}`;
  const renderArgs = `--template codebase --cwd ${cwdArg} --project-cwd ${shellQuote(opts.projectCwd)} ${modeArgs}${untrackedArg} --detail ${opts.detail} ${outArg} ${openArg}`;
  const diffArgs = opts.mode === "staged" ? "diff --cached" : opts.mode === "baseRef" ? `diff ${shellQuote(opts.base || "HEAD")}` : "diff HEAD";

  if (opts.detail === "ultralow" || opts.detail === "low") return buildEphemeralReviewPrompt({ cliPath, cli, cwdArg, opts, renderArgs, diffArgs });
  return buildScaffoldReviewPrompt({ cliPath, cli, cwdArg, opts, renderArgs, diffArgs });
}

function buildScaffoldReviewPrompt(input: { cliPath: string; cli: string; cwdArg: string; opts: ReviewCommandOptions; renderArgs: string; diffArgs: string }): string {
  const { cliPath, cli, cwdArg, opts, renderArgs, diffArgs } = input;
  const reportPath = `/tmp/pi-review-report-${Date.now()}.json`;
  const inputArg = shellQuote(reportPath);
  const scaffoldCommand = `node ${cli} scaffold --template codebase --cwd ${cwdArg} ${renderModeArgs(opts)}${opts.includeUntracked ? " --include-untracked" : ""} --detail ${opts.detail} --output ${inputArg}`;
  const renderCommand = `node ${cli} render --input ${inputArg} ${renderArgs}`;

  return `${commonReviewHeader(cliPath, opts)}

Workflow requirements:
1. Run the scaffold command exactly. It writes a draft codebase-review JSON report containing changed file paths and TODO_REPLACE placeholders.
2. Inspect changed files and important adjacent files in ${opts.targetCwd} using targeted reads and Git metadata. Use GitHub for raw diffs; this artifact should explain how the code currently works.
3. Fill the scaffold JSON at ${reportPath}. Replace every TODO_REPLACE placeholder. Set report.title to a concise subject for the HTML filename (render writes <subject>.html after slugging spaces/symbols to hyphens). Do not include HTML, Mermaid, raw diffs, or inline copied code in the JSON. Include code snippets only as path + startLine/endLine references. Do not invent test outcomes.
4. Render with the codebase template. Render performs schema validation, placeholder rejection, detail-profile validation, git metadata collection, snippet resolution from local files, and HTML generation in one step. If render fails, fix the JSON and rerun render.
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
# Inspect relevant files with targeted reads and record only snippet line ranges in JSON.
\`\`\`

Then run render exactly after filling the report:
\`\`\`bash
${renderCommand}
\`\`\`

Only if you are unsure about the schema shape, run these fallback references:
\`\`\`bash
node ${cli} guide --template codebase
node ${cli} example --template codebase
\`\`\`
`;
}

function buildEphemeralReviewPrompt(input: { cliPath: string; cli: string; cwdArg: string; opts: ReviewCommandOptions; renderArgs: string; diffArgs: string }): string {
  const { cliPath, cli, cwdArg, opts, renderArgs, diffArgs } = input;
  const renderCommandPrefix = `node ${cli} render --stdin ${renderArgs}`;

  return `${commonReviewHeader(cliPath, opts)}

Workflow requirements for ${opts.detail} detail:
1. Do not run scaffold and do not write a report JSON file to /tmp.
2. Inspect changed files and important adjacent files in ${opts.targetCwd} using targeted reads and Git metadata. Use GitHub for raw diffs; this artifact should explain how the code currently works.
3. Generate compact codebase-review JSON directly in the render command here-doc. Set report.title to a concise subject for the HTML filename (render writes <subject>.html after slugging spaces/symbols to hyphens). Do not include HTML, Mermaid, raw diffs, or inline copied code in the JSON. Include code snippets only as path + startLine/endLine references. Do not invent test outcomes.
4. Render with the codebase template. Render performs schema validation, placeholder rejection, detail-profile validation, git metadata collection, snippet resolution from local files, and HTML generation in one step. If render fails, fix the here-doc JSON and rerun render.
5. Return the final Artifact path plus a concise reviewer summary.

Suggested Git inspection commands:
\`\`\`bash
git -C ${cwdArg} status --short
git -C ${cwdArg} ${diffArgs} --stat
git -C ${cwdArg} ${diffArgs} --name-status --find-renames
# Inspect relevant files with targeted reads and record only snippet line ranges in JSON.
\`\`\`

Use this JSON shape for the here-doc. Keep it concise and replace all example text; choose a title that makes a good slugged filename:
\`\`\`json
${ephemeralJsonShape(opts.detail)}
\`\`\`

Run render with stdin after inspecting the code:
\`\`\`bash
${renderCommandPrefix} <<'PI_REVIEW_JSON'
${ephemeralJsonShape(opts.detail)}
PI_REVIEW_JSON
\`\`\`

Only if you are unsure about the schema shape, run these fallback references:
\`\`\`bash
node ${cli} guide --template codebase
node ${cli} example --template codebase
\`\`\`
`;
}

function commonReviewHeader(cliPath: string, opts: ReviewCommandOptions): string {
  return `Create a codebase-review HTML artifact for the final requested change set. Raw diffs must be omitted; GitHub already provides them.

Use this exact local CLI; do not assume pi-review-artifact is on PATH:
- CLI path: ${cliPath}
- Target cwd: ${opts.targetCwd}
- Pi agent cwd for global project slug: ${opts.projectCwd}
- Template: codebase
- Diff mode: ${opts.mode}${opts.base ? ` (${opts.base})` : ""}
- Include untracked files: ${opts.includeUntracked ? "yes" : "no"}
- Review detail: ${opts.detail}
- Output location: ${outputLocationDescription(opts.out)}
- Open artifact after render: ${opts.open ? "yes" : "no"}${userPromptInstructions(opts)}

Filename rule:
- The report title controls the HTML filename. Choose a concise subject related to the change; render writes it as <subject>.html after converting spaces and non-alphanumeric symbols to hyphens.

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
  const validation = detail === "low" ? `,
  "validation": { "runs": [] },
  "missingValidation": ["Checks not run, or [] if none"]` : "";
  return `{
  "schemaVersion": "2.0",
  "artifactKind": "codebase-review",
  "reviewDetail": "${detail}",
  "title": "concise change subject for filename",
  "status": {
    "currentState": "What the relevant code currently does.",
    "reviewScope": "What this artifact covers.",
    "changeSummary": "High-level behavior/configuration change."
  },
  "fileMap": [
    { "path": "path/from/git-metadata", "changed": true, "role": "What this file is responsible for.", "whyRelevant": "Why it matters to the review." }
  ],
  "buildingBlocks": [
    { "name": "Main building block", "kind": "module", "description": "What it does.", "files": ["path/from/git-metadata"], "snippetIds": ["focused-snippet"] }
  ],
  "workflows": [
    { "name": "Main workflow", "summary": "How the code path works.", "steps": [
      { "label": "Step", "description": "What happens.", "files": ["path/from/git-metadata"], "snippetIds": ["focused-snippet"] }
    ] }
  ],
  "snippets": [
    { "id": "focused-snippet", "path": "path/from/git-metadata", "startLine": 1, "endLine": 20, "caption": "Why these lines matter." }
  ]${validation}
}`;
}

function detailInstructions(detail: ReviewDetail): string {
  if (detail === "ultralow") {
    return `- Ultralow: fastest compact handoff. Include current status, a concise changed-file map, optional workflow/block context, 0-3 snippet line ranges, minimal validation notes, no raw diffs or inline code, and a concise title that becomes the subject-based HTML filename.`;
  }
  if (detail === "low") {
    return `- Low: concise internal handoff. Include file roles, at least one building block/workflow/data flow, 1-6 focused snippet line ranges, validation/missingValidation, only critical risks, no raw diffs or inline code, and a concise title that becomes the subject-based HTML filename.`;
  }
  if (detail === "high") {
    return `- High: rigorous codebase map. Cover every changed file plus important adjacent files, explain building blocks, workflows and data flows, include 4-25 focused snippet line ranges, add review focus/risk/decision/limitation sections, detailed validation evidence, no raw diffs or inline code, and a concise title that becomes the subject-based HTML filename.`;
  }
  return `- Medium: shareable coherent codebase map. Cover all changed files where possible, include important adjacent files, building blocks, at least one workflow/data flow, 2-12 focused snippet line ranges, review focus, validation/missingValidation, relevant risks/decisions/knownLimitations, no raw diffs or inline code, and a concise title that becomes the subject-based HTML filename.`;
}

function reviewDevHelpText(cliPath: string, currentCwd: string): string {
  return `# /pr-dev help

Render dummy codebase-review review HTML fixtures from inside Pi without invoking the agent.

## How to use it

Type \`/pr-dev\` to open the guided fixture wizard. No flags or positional arguments are required or parsed.

The wizard asks for:

- Target cwd: current Pi cwd (\`${currentCwd}\`) or another path.
- Detail tier: all, ultralow, low, medium, or high.
- Output location: repo html-reviews, local Pi store, or global Pi store.
- Whether to open the generated artifact(s).

## What /pr-dev does

- Runs the local CLI command \`dev-render\` using \`pi.exec\`.
- Loads static dummy review JSON and a static dummy GitSnapshot fixture.
- Calls the same codebase HTML renderer used by production review artifacts.
- Does not call \`pi.sendUserMessage\`.
- Does not start an agent turn.
- Does not inspect real git state.
- Does not generate JSON with a model.

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

Create a shareable codebase-review artifact from compact JSON, local git metadata, and curated code snippet line ranges. Raw diffs are intentionally omitted because GitHub already provides them.

## How to use it

Type \`/pr\` to open the guided review wizard. No flags or positional arguments are required or parsed.

The wizard asks for:

- Target cwd: current Pi cwd (\`${currentCwd}\`) or another path.
- Diff mode: worktree changes, staged changes, or compare with a base ref.
- Base ref: defaults to \`HEAD\` when base-ref mode is selected.
- Whether to include untracked files for worktree reviews.
- Review depth: ultralow, low, medium, or high.
- Output location: repo html-reviews, local Pi store, or global Pi store.
- Whether to open the generated artifact.
- Optional review emphasis, such as security boundaries or API compatibility.

## Detail tiers

- Ultralow — current status, concise file map, optional workflow/block, 0-3 snippet ranges. Uses direct stdin JSON; no /tmp report.
- Low — compact file map, at least one workflow/block/data flow, 1-6 snippet ranges, validation or missingValidation. Uses direct stdin JSON; no /tmp report.
- Medium — full changed-file map, important adjacent files, building blocks, workflow/data flow, review focus, 2-12 snippet ranges. Uses scaffolded /tmp JSON.
- High — rigorous codebase map with broader context, multiple focus/risk/decision sections, 4-25 snippet ranges, limitations and validation evidence. Uses scaffolded /tmp JSON.

## What the agent will do

- Inspect changed files and relevant adjacent files with targeted reads.
- Generate JSON that explains how the current code works.
- Reference code snippets by \`path\`, \`startLine\`, and \`endLine\` only.
- Avoid raw diffs, HTML, Mermaid, and inline copied code in JSON.
- Let the CLI resolve snippet content locally and render the final HTML.

## Direct CLI fallback

CLI path for this extension:
\`${cliPath}\`

Example direct commands:
\`\`\`bash
node '${cliPath}' scaffold --template codebase --cwd '${currentCwd}' --mode worktree --include-untracked --detail medium --output /tmp/pi-review-report.json
node '${cliPath}' render --input /tmp/pi-review-report.json --template codebase --cwd '${currentCwd}' --mode worktree --include-untracked --detail medium --out repo --no-open
node '${cliPath}' render --stdin --template codebase --cwd '${currentCwd}' --mode worktree --include-untracked --detail low --out localpi --no-open <<'JSON'
{"schemaVersion":"2.0","artifactKind":"codebase-review","reviewDetail":"low","title":"Example","status":{"currentState":"Example current behavior.","reviewScope":"Example scope.","changeSummary":"Example summary."},"fileMap":[{"path":"file.ts","changed":true,"role":"Example role."}],"buildingBlocks":[{"name":"Example block","kind":"module","description":"Example.","files":["file.ts"],"snippetIds":["example"]}],"workflows":[{"name":"Example workflow","summary":"Example.","steps":[{"label":"Step","description":"Example.","files":["file.ts"],"snippetIds":["example"]}]}],"snippets":[{"id":"example","path":"file.ts","startLine":1,"endLine":20,"caption":"Example snippet."}],"validation":{"runs":[]},"missingValidation":["Example only."]}
JSON
\`\`\`

## Cheap development fixture rendering

Use \`/pr-dev\` to render static dummy HTML artifacts through the same codebase renderer without invoking the agent or reading real git state.

## Troubleshooting

- If render says \`not a git repository\`, run \`/pr\` again and choose the correct repo path.
- If validation reports unresolved placeholders, edit the scaffold JSON or stdin JSON and replace every \`TODO_REPLACE\` string.
- If snippet warnings appear, adjust the snippet path/line range or add a stable \`mustContain\` anchor.
- If the artifact omits new files, run \`/pr\` again and include untracked files or ensure files are staged/tracked.
`;
}

function outputLocationDescription(out: ReviewOut): string {
  if (out === "global") return "global (~/.pi/agent/reviews/<project-slug>/, where project slug is the Pi agent cwd basename)";
  if (out === "localpi") return "local Pi store (.pi/reviews/ under the git root)";
  return "repo html-reviews (html-reviews/ under the target git repository root)";
}


function padAnsi(input: string, width: number): string {
  const plain = stripAnsi(input);
  const truncated = plain.length > width ? plain.slice(0, Math.max(0, width - 1)) + "…" : input;
  const visible = stripAnsi(truncated).length;
  return visible >= width ? truncated : truncated + " ".repeat(width - visible);
}

function stripAnsi(input: string): string {
  return input.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
