import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { buildFreshContextMessage, FRESH_CONTEXT_MESSAGE_TYPE } from "./context-message.js";
import { prepareSelectedFiles, verifyPreparedFilesUnchanged } from "./files.js";
import { buildReadLedger } from "./ledger.js";
import { limitsForContextWindow } from "./limits.js";
import { selectRelevantPaths } from "./selection.js";
import type { FreshOutcome, PreparedContext } from "./types.js";
import { reviewFreshTransition, runSelectionLoader } from "../ui/fresh-review.js";

export async function runFreshContextSession(
  ctx: ExtensionCommandContext,
  initialObjective = "",
): Promise<FreshOutcome> {
  if (ctx.mode !== "tui") return fail(ctx, "preflight", "/cnew requires interactive TUI mode");
  if (!ctx.model) return fail(ctx, "preflight", "Select a model before running /cnew");

  try {
    await ctx.waitForIdle();
  } catch (error) {
    return fail(ctx, "idle", messageOf(error));
  }

  const limits = limitsForContextWindow(ctx.model.contextWindow);
  const ledger = buildReadLedger(ctx.sessionManager.getBranch(), ctx.cwd);
  if (ledger.candidates.length === 0) return fail(ctx, "ledger", "No successful file reads were found on the active session branch");
  if (ledger.candidates.length > limits.maxLedgerFiles) {
    return fail(ctx, "ledger", `The active branch has more than ${limits.maxLedgerFiles} read files; no files were silently omitted`);
  }

  let selectedPaths: string[] | undefined;
  try {
    selectedPaths = await runSelectionLoader(ctx, (signal) => selectRelevantPaths(ctx, ledger, limits.maxSelectedFiles, signal));
  } catch (error) {
    return fail(ctx, "selection", messageOf(error));
  }
  if (!selectedPaths) {
    ctx.ui.notify("Fresh session cancelled", "info");
    return { status: "cancelled" };
  }

  let prepared: PreparedContext;
  try {
    prepared = await prepareSelectedFiles(selectedPaths, ledger, limits);
  } catch (error) {
    return fail(ctx, "preparation", messageOf(error));
  }
  if (prepared.blockedReason) return fail(ctx, "preparation", prepared.blockedReason);

  const review = await reviewFreshTransition(ctx, prepared, initialObjective);
  if (review.action === "cancel") {
    restoreObjectiveDraft(ctx, review.objective);
    ctx.ui.notify("Fresh session cancelled; objective kept in the editor", "info");
    return { status: "cancelled", objective: review.objective };
  }

  try {
    await verifyPreparedFilesUnchanged(prepared.included, ledger.projectRoot);
  } catch (error) {
    restoreObjectiveDraft(ctx, review.objective);
    return fail(ctx, "verification", `${messageOf(error)}. Review the file set again before transitioning.`);
  }

  return createPreparedSession(ctx, prepared, review.objective);
}

export async function createPreparedSession(
  ctx: ExtensionCommandContext,
  prepared: PreparedContext,
  objective: string,
): Promise<FreshOutcome> {
  const sourceSessionFile = ctx.sessionManager.getSessionFile();
  const contextMessage = buildFreshContextMessage(prepared);
  let submissionError: string | undefined;

  try {
    const result = await ctx.newSession({
      parentSession: sourceSessionFile,
      setup: async (sessionManager) => {
        sessionManager.appendCustomMessageEntry(
          FRESH_CONTEXT_MESSAGE_TYPE,
          contextMessage.content,
          true,
          contextMessage.details,
        );
      },
      withSession: async (replacementCtx) => {
        try {
          await replacementCtx.sendUserMessage(objective);
        } catch (error) {
          submissionError = messageOf(error);
          replacementCtx.ui.setEditorText(objective);
          replacementCtx.ui.notify(`Fresh context was created, but the objective was not submitted: ${submissionError}`, "error");
        }
      },
    });

    if (result.cancelled) {
      ctx.ui.notify("Fresh session creation was cancelled", "info");
      restoreObjectiveDraft(ctx, objective);
      return { status: "cancelled", objective };
    }
    if (submissionError) return { status: "failed", stage: "submission", message: submissionError };
    return { status: "completed" };
  } catch (error) {
    const message = messageOf(error);
    try {
      restoreObjectiveDraft(ctx, objective);
      ctx.ui.notify(`Fresh session transition failed: ${message}`, "error");
    } catch {
      // The old command context may already be stale if replacement reached teardown.
    }
    return { status: "failed", stage: "transition", message };
  }
}

function restoreObjectiveDraft(ctx: ExtensionCommandContext, objective: string): void {
  if (objective) ctx.ui.setEditorText(objective);
}

function fail(ctx: ExtensionCommandContext, stage: string, message: string): FreshOutcome {
  ctx.ui.notify(message, "error");
  return { status: "failed", stage, message };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
