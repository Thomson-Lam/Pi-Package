import fs from "node:fs/promises";
import crypto from "node:crypto";
import type { PlanAttachmentState, PlanModeState } from "./types.js";

export const AUTO_DIFF_CHAR_LIMIT = 4000;
export const TOOL_DIFF_CHAR_LIMIT = 20000;

export function sha256(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

export function createAttachment(planName: string, planPath: string, content: string): PlanAttachmentState {
  const attachedHash = sha256(content);
  return {
    planName,
    planPath,
    attachedHash,
    attachedAt: Date.now(),
    baselineContent: content,
    currentHash: attachedHash,
  };
}

function toLines(text: string): string[] {
  return text.split("\n");
}

export function createUnifiedDiff(baseline: string, current: string): string {
  if (baseline === current) return "";
  const a = toLines(baseline);
  const b = toLines(current);
  const max = Math.max(a.length, b.length);
  const body: string[] = [];
  for (let i = 0; i < max; i += 1) {
    const left = a[i];
    const right = b[i];
    if (left === right) continue;
    if (left !== undefined) body.push(`-${left}`);
    if (right !== undefined) body.push(`+${right}`);
  }
  return [`--- attached`, `+++ current`, `@@`, ...body].join("\n");
}

function renderSmallDiffNotification(planName: string, planPath: string, diff: string): string {
  return `Plan document changed: ${planName}\nPath: ${planPath}\nNew changes made to the plan:\n\n\`\`\`diff\n${diff}\n\`\`\``;
}

function renderLargeDiffNotification(planName: string, planPath: string): string {
  return `Plan document changed: ${planName}\nPath: ${planPath}\nThe attached snapshot is stale.\nThe diff is too large to inject automatically.\nCall \`plan_diff\` to inspect the changes before relying on the old attached snapshot.`;
}

function renderDeletedNotification(planName: string, planPath: string): string {
  return `Attached plan ${planName} no longer exists on disk.\nPath: ${planPath}\nDo not rely on the attached snapshot as current state.`;
}

export interface FreshnessNotification {
  content: string;
  details: Record<string, unknown>;
}

export async function collectFreshnessNotifications(state: PlanModeState): Promise<FreshnessNotification[]> {
  const notifications: FreshnessNotification[] = [];
  for (const attachment of Object.values(state.planAttachments)) {
    try {
      const currentContent = await fs.readFile(attachment.planPath, "utf8");
      const currentHash = sha256(currentContent);
      attachment.currentHash = currentHash;

      if (currentHash === attachment.attachedHash) {
        attachment.lastNotifiedHash = undefined;
        continue;
      }
      if (currentHash === attachment.lastNotifiedHash) continue;

      const diff = createUnifiedDiff(attachment.baselineContent, currentContent);
      const includesDiff = diff.length <= AUTO_DIFF_CHAR_LIMIT;
      notifications.push({
        content: includesDiff
          ? renderSmallDiffNotification(attachment.planName, attachment.planPath, diff)
          : renderLargeDiffNotification(attachment.planName, attachment.planPath),
        details: {
          planName: attachment.planName,
          planPath: attachment.planPath,
          currentHash,
          includesDiff,
          diffChars: diff.length,
        },
      });
      attachment.lastNotifiedHash = currentHash;
    } catch {
      if (attachment.lastNotifiedHash === "__missing__") continue;
      attachment.currentHash = undefined;
      attachment.lastNotifiedHash = "__missing__";
      notifications.push({
        content: renderDeletedNotification(attachment.planName, attachment.planPath),
        details: {
          planName: attachment.planName,
          planPath: attachment.planPath,
          missing: true,
        },
      });
    }
  }
  return notifications;
}

export async function computePlanDiff(
  attachment: PlanAttachmentState,
): Promise<{ changed: boolean; currentHash?: string; diff: string; missing: boolean }> {
  try {
    const currentContent = await fs.readFile(attachment.planPath, "utf8");
    const currentHash = sha256(currentContent);
    const diff = createUnifiedDiff(attachment.baselineContent, currentContent);
    return { changed: currentHash !== attachment.attachedHash, currentHash, diff, missing: false };
  } catch {
    return { changed: true, diff: "", missing: true };
  }
}
