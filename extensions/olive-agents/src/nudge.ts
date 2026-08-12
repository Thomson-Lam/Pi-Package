/**
 * nudge.ts — Hold completion notifications until the parent agent is idle.
 *
 * The old implementation delivered a nudge 200ms after settle — too early to
 * be cancelled by a get_subagent_result called later in the same busy turn,
 * so the main agent could receive a redundant notification for a result it
 * had already fetched. The scheduler instead holds nudges while the parent
 * is busy (or an approval dialog is open) and flushes them at the next idle
 * boundary. Each nudge re-checks `resultConsumed` at send time, so explicit
 * consumption any time during a turn genuinely suppresses delivery.
 */

export class NudgeScheduler {
  private pending = new Map<string, () => void>();
  private busy = false;

  /** True while the parent agent is mid-turn (agent_start … agent_settled). */
  setBusy(b: boolean): void {
    this.busy = b;
  }

  /** Register a nudge. Delivery happens on the next flush when idle. */
  schedule(key: string, send: () => void): void {
    this.pending.set(key, send);
  }

  /** Cancel a pending nudge (e.g. the result was consumed). */
  cancel(key: string): void {
    this.pending.delete(key);
  }

  /** Drop all pending nudges (session shutdown). */
  clear(): void {
    this.pending.clear();
  }

  /**
   * Deliver all pending nudges if the parent is idle. Caller is responsible
   * for the approval-dialog gate (flush must not run mid-dialog).
   */
  flush(): void {
    if (this.busy) return;
    const sends = [...this.pending.values()];
    this.pending.clear();
    for (const send of sends) {
      try { send(); } catch { /* ignore stale completion side-effect errors */ }
    }
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}
