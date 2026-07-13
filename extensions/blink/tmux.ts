export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

type Exec = (command: string, args: string[]) => Promise<ExecResult>;

interface TmuxOptions {
  ownerPane: string;
  cwd: string;
  reviewScript: string;
  exec: Exec;
  prefixArgs?: string[];
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export class TmuxAdapter {
  private readonly ownerPane: string;
  private readonly cwd: string;
  private readonly reviewScript: string;
  private readonly execCommand: Exec;
  private readonly prefixArgs: string[];
  private reviewPane: string | undefined;
  private reviewId: string | undefined;

  constructor(options: TmuxOptions) {
    if (!options.ownerPane) throw new Error("Blink requires TMUX_PANE to identify Pi's owner pane.");
    this.ownerPane = options.ownerPane;
    this.cwd = options.cwd;
    this.reviewScript = options.reviewScript;
    this.execCommand = options.exec;
    this.prefixArgs = options.prefixArgs ?? [];
  }

  private run(args: string[]): Promise<ExecResult> {
    return this.execCommand("tmux", [...this.prefixArgs, ...args]);
  }

  private paneCommand(reviewId: string, mode: "slow" | "blitz", socketPath: string): string {
    const environment: Record<string, string> = {
      BLINK_REVIEW_ID: reviewId,
      BLINK_SOCKET_PATH: socketPath,
      BLINK_MODE: mode,
      BLINK_CWD: this.cwd,
      BLINK_PROTOCOL_VERSION: "1",
    };
    const assignments = Object.entries(environment).map(([key, value]) => `${key}=${shellQuote(value)}`).join(" ");
    // The pane marks itself before Neovim starts. If marking fails, the shell
    // exits and cannot leave a live unidentifiable review process behind.
    const mark = [
      `tmux set-option -p -t \"$TMUX_PANE\" @blink_role review`,
      `tmux set-option -p -t \"$TMUX_PANE\" @blink_owner ${shellQuote(this.ownerPane)}`,
      `tmux set-option -p -t \"$TMUX_PANE\" @blink_review_id ${shellQuote(reviewId)}`,
    ].join(" && ");
    return `${mark} && ${assignments} exec nvim -S ${shellQuote(this.reviewScript)}`;
  }

  async create(reviewId: string, mode: "slow" | "blitz", socketPath: string): Promise<string> {
    const result = await this.run([
      "split-window", "-d", "-h", "-f", "-l", "70%", "-t", this.ownerPane,
      "-c", this.cwd, "-P", "-F", "#{pane_id}",
      this.paneCommand(reviewId, mode, socketPath),
    ]);
    if (result.code !== 0) throw new Error(`Blink could not create the tmux review pane: ${result.stderr.trim() || `exit ${result.code}`}`);
    const pane = result.stdout.trim();
    if (!/^%\d+$/.test(pane)) throw new Error(`Blink received an invalid tmux pane ID: ${pane}`);

    try {
      await this.setMetadata(pane, "@blink_role", "review");
      await this.setMetadata(pane, "@blink_owner", this.ownerPane);
      await this.setMetadata(pane, "@blink_review_id", reviewId);
      this.reviewPane = pane;
      this.reviewId = reviewId;
      if (!await this.verify(pane, reviewId)) throw new Error("Blink tmux pane metadata verification failed.");
      const focus = await this.run(["select-pane", "-t", pane]);
      if (focus.code !== 0) throw new Error(`Blink could not focus review pane ${pane}: ${focus.stderr.trim()}`);
      return pane;
    } catch (error) {
      if (await this.verify(pane, reviewId)) {
        await this.run(["kill-pane", "-t", pane]).catch(() => undefined);
      }
      this.reviewPane = undefined;
      this.reviewId = undefined;
      throw error;
    }
  }

  private async setMetadata(pane: string, key: string, value: string): Promise<void> {
    const result = await this.run(["set-option", "-p", "-t", pane, key, value]);
    if (result.code !== 0) throw new Error(`Blink could not set ${key} on ${pane}: ${result.stderr.trim()}`);
  }

  async verify(pane = this.reviewPane, reviewId = this.reviewId): Promise<boolean> {
    if (!pane || !reviewId) return false;
    const result = await this.run([
      "display-message", "-p", "-t", pane,
      "#{@blink_role}\t#{@blink_owner}\t#{@blink_review_id}",
    ]).catch(() => ({ stdout: "", stderr: "", code: 1 }));
    return result.code === 0 && result.stdout.trim() === `review\t${this.ownerPane}\t${reviewId}`;
  }

  async isPaneActive(): Promise<boolean> {
    if (!this.reviewPane || !await this.verify()) return false;
    const result = await this.run(["display-message", "-p", "-t", this.reviewPane, "#{pane_active}"]);
    return result.code === 0 && result.stdout.trim() === "1";
  }

  async ensure(reviewId: string, mode: "slow" | "blitz", socketPath: string): Promise<string> {
    if (this.reviewPane && this.reviewId === reviewId && await this.verify()) return this.reviewPane;
    this.reviewPane = undefined;
    this.reviewId = undefined;
    return this.create(reviewId, mode, socketPath);
  }

  async close(): Promise<void> {
    const pane = this.reviewPane;
    const reviewId = this.reviewId;
    this.reviewPane = undefined;
    this.reviewId = undefined;
    if (!pane || !reviewId || !await this.verify(pane, reviewId)) return;
    await this.run(["select-pane", "-t", this.ownerPane]).catch(() => undefined);
    await this.run(["kill-pane", "-t", pane]).catch(() => undefined);
  }

  adoptForTest(pane: string, reviewId: string): void {
    this.reviewPane = pane;
    this.reviewId = reviewId;
  }
}
