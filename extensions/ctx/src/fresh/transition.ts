import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { buildFreshContextMessage, FRESH_CONTEXT_MESSAGE_TYPE } from "./context-message.js";
import { prepareSelectedFiles, verifyPreparedFilesUnchanged } from "./files.js";
import { buildReadLedger } from "./ledger.js";
import { limitsForContextWindow } from "./limits.js";
import { selectRelevantPaths } from "./selection.js";
import type { FreshOutcome, PreparedContext } from "./types.js";
import { reviewFreshTransition, runSelectionLoader } from "../ui/fresh-review.js";
import {
  orderModels,
  selectModelAndThinking,
  type ModelThinkingSelection,
} from "../ui/model-thinking-selector.js";

export interface FreshSessionOptions {
  /** Extra entries to append during new-session setup, after the fresh-context message. */
  appendSetupEntries?: (sessionManager: { appendCustomEntry(type: string, data?: unknown): void }) => void;
}

export async function runFreshContextSession(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  initialObjective = "",
  options: FreshSessionOptions = {},
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

  let selection;
  try {
    selection = await runSelectionLoader(ctx, () => selectRelevantPaths(pi, ledger, limits.maxSelectedFiles));
  } catch (error) {
    return fail(ctx, "selection", messageOf(error));
  }
  if (!selection) {
    ctx.ui.notify("Fresh session cancelled", "info");
    return { status: "cancelled" };
  }

  let prepared: PreparedContext;
  try {
    prepared = await prepareSelectedFiles(selection.selectedPaths, selection.ledger, {
      ...limits,
      maxTransferTokens: Number.MAX_SAFE_INTEGER,
    });
  } catch (error) {
    return fail(ctx, "preparation", messageOf(error));
  }
  if (prepared.blockedReason) return fail(ctx, "preparation", prepared.blockedReason);

  if (selection.suggestedPaths.length > 0) {
    ctx.ui.notify(`Agent added ${selection.suggestedPaths.length} suggested file(s) outside the read ledger for review`, "info");
  }

  const models = orderModels(ctx.modelRegistry.getAvailable());
  if (models.length === 0) return fail(ctx, "model", "No models are available");

  let objective = initialObjective;
  let modelSelection: ModelThinkingSelection | undefined;
  while (true) {
    const review = await reviewFreshTransition(ctx, prepared, objective, modelSelection);
    objective = review.objective;
    if (review.action === "cancel") {
      restoreObjectiveDraft(ctx, objective);
      ctx.ui.notify("Fresh session cancelled; objective kept in the editor", "info");
      return { status: "cancelled", objective };
    }
    if (review.action === "select-model") {
      const nextSelection = await selectModelAndThinking(ctx, models, prepared.estimatedTokens, modelSelection);
      if (nextSelection) modelSelection = nextSelection;
      continue;
    }
    if (modelSelection) break;
  }

  if (!modelSelection) return fail(ctx, "model", "No model was selected");
  const targetLimits = limitsForContextWindow(modelSelection.model.contextWindow);
  if (prepared.estimatedTokens > targetLimits.maxTransferTokens) {
    restoreObjectiveDraft(ctx, objective);
    return fail(ctx, "model", `Estimated file context (${prepared.estimatedTokens} tokens) exceeds the selected model's ${targetLimits.maxTransferTokens}-token limit`);
  }

  try {
    await verifyPreparedFilesUnchanged(prepared.included, selection.ledger.projectRoot);
  } catch (error) {
    restoreObjectiveDraft(ctx, objective);
    return fail(ctx, "verification", `${messageOf(error)}. Review the file set again before transitioning.`);
  }

  const originalModel = ctx.model;
  const originalThinkingLevel = pi.getThinkingLevel();
  const modelChanged = await pi.setModel(modelSelection.model);
  if (!modelChanged) {
    restoreObjectiveDraft(ctx, objective);
    return fail(ctx, "model", `No API key for ${modelSelection.model.provider}/${modelSelection.model.id}`);
  }
  pi.setThinkingLevel(modelSelection.thinkingLevel);

  const outcome = await createPreparedSession(ctx, prepared, objective, options);
  if (outcome.status === "cancelled" || (outcome.status === "failed" && outcome.stage === "transition")) {
    try {
      await pi.setModel(originalModel);
      pi.setThinkingLevel(originalThinkingLevel);
    } catch {
      // Session replacement may already have made the original extension runtime stale.
    }
  }
  return outcome;
}

export async function createPreparedSession(
  ctx: ExtensionCommandContext,
  prepared: PreparedContext,
  objective: string,
  options: FreshSessionOptions = {},
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
        options.appendSetupEntries?.(sessionManager);
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
