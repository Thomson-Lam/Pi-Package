/**
 * child-handoff.mjs — Build the approved constrained-context packet as an
 * agent-start message for a freshly launched child session. Plain ESM so
 * child-host.mjs can import it under `node` without a loader.
 *
 * Delivery channel: `before_agent_start`. Pre-appended SESSION entries (custom
 * or user) are invisible to the child's first run — AgentSession's prompt()
 * builds the request from the agent's own message state plus the new task, so
 * entries written to the SessionManager before InteractiveMode starts never
 * reach the model payload. Messages returned by a before_agent_start handler
 * ARE pushed into that exact prompt array, then converted custom→user by the
 * SDK's convertToLlm before provider serialization — so they reliably reach
 * the child's context. The packet stays out of the delegated task and out of
 * the system prompt.
 */

/** True when the host must deliver the approved packet on first start:
 *  fresh sessions only — reopening attaches an existing session and must
 *  never re-inject the handoff. */
export function shouldInjectHandoff(spec) {
  return !!(spec && !spec.session?.openFile && spec.run?.handoff);
}

/**
 * Wire the handoff delivery into the child's extension bridge: on the FIRST
 * prompt of a fresh session carrying an approved packet, before_agent_start
 * returns the packet as a distinct message (injected exactly once per child
 * process; reopen specs never register it).
 * @param {{ on: (event: string, handler: (event: any) => unknown) => void }} pi
 * @param {import("./handoff/serialize.js").DeliveredContextHandoff | undefined} specHandoff
 * @param {boolean} isFreshSession
 */
export function wireHandoffBridge(pi, spec) {
  if (!shouldInjectHandoff(spec)) return;
  let injected = false;
  pi.on("before_agent_start", () => {
    if (injected) return undefined;
    injected = true;
    return { message: buildHandoffMessage(spec.run.handoff) };
  });
}

/**
 * @param {import("./handoff/serialize.js").DeliveredContextHandoff | undefined} handoff
 * @returns {{ customType: string; content: string; display: boolean } | undefined}
 */
export function buildHandoffMessage(handoff) {
  if (!handoff) return undefined;
  const details = handoff.details;
  const hasItems =
    (Array.isArray(details?.snippets) && details.snippets.length > 0) ||
    (Array.isArray(details?.recommendedFiles) && details.recommendedFiles.length > 0);
  if (!hasItems) return undefined;
  const content = typeof handoff.content === "string" && handoff.content ? handoff.content : "";
  if (!content) return undefined;
  return { customType: "olive-agent-context", content, display: true };
}