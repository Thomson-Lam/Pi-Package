/**
 * Generic child prompt policy. This module deliberately knows nothing about
 * any particular extension; it only preserves or restores Pi's base prompt.
 */

/**
 * Register a final prompt handler for the native policy.
 * The caller supplies the base prompt captured from the child session before
 * the first run. Other extensions and their tools remain loaded.
 */
export function registerPromptPolicy(pi, policy, getNativePrompt) {
  pi.on("before_agent_start", () => {
    if (policy === "native") {
      const prompt = getNativePrompt();
      if (prompt !== undefined) return { systemPrompt: prompt };
    }
  });
}
