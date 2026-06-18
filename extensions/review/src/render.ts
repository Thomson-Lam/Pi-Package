import { ReviewReport } from "./schema.js";
import { GitSnapshot } from "./git.js";
import { baseHtml } from "./templates/base.js";
import { escapeHtml } from "./templates/components.js";
import { renderChapters } from "./templates/chapters.js";

export type ArtifactTemplate = "chapters";

export function renderHtml(report: ReviewReport, git: GitSnapshot, commands: string[], template: ArtifactTemplate = "chapters"): string {
  if (template !== "chapters") {
    throw new Error(`Unsupported template: ${template}`);
  }
  return baseHtml(escapeHtml(report.title), renderChapters(report, git, commands));
}
