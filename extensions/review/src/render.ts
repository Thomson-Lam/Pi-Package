import { ReviewReport } from "./schema.js";
import { GitSnapshot } from "./git.js";
import { baseHtml } from "./templates/base.js";
import { escapeHtml } from "./templates/components.js";
import { renderCodebaseReview } from "./templates/codebase.js";
import { resolveSnippets } from "./snippets.js";

export type ArtifactTemplate = "codebase";

export function renderHtml(report: ReviewReport, git: GitSnapshot, commands: string[], template: ArtifactTemplate = "codebase"): string {
  if (template !== "codebase") {
    throw new Error(`Unsupported template: ${template}`);
  }
  const snippets = resolveSnippets(report, git);
  return baseHtml(escapeHtml(report.title), renderCodebaseReview(report, git, commands, snippets));
}
