import type { NudgeRow } from "../shared/nudge";

type Schedule = (callback: () => void, delayMs: number) => () => void;

const defaultSchedule: Schedule = (callback, delayMs) => {
  const timer = setTimeout(callback, delayMs);
  return () => clearTimeout(timer);
};

export interface NudgeRequest {
  agentId: string;
  pattern: string;
  followUp: string;
  delayMs: number;
  /** Shows the nudge's current state in the agent's timeline. */
  publish(row: NudgeRow): Promise<void>;
  /** Sends the follow-up. Called at most once, after the row says "sent". */
  deliver(): Promise<void>;
  /** False when the agent moved on or Juke settings changed since the verdict. */
  stillCurrent(): Promise<boolean>;
}

interface Pending { request: NudgeRequest; row: NudgeRow; cancelTimer: () => void }

/**
 * Holds each agent's latest "continue" verdict for a visible, cancellable delay. A new turn, a
 * pause, Cancel, or a newer verdict withdraws it; Now sends it early.
 */
export class NudgeQueue {
  private readonly pending = new Map<string, Pending>();
  private readonly options: { now?: () => number; schedule?: Schedule; log?: (message: string, detail: object) => void };

  constructor(options: { now?: () => number; schedule?: Schedule; log?: (message: string, detail: object) => void } = {}) {
    this.options = options;
  }

  private get now() { return this.options.now ?? Date.now; }

  async enqueue(request: NudgeRequest): Promise<void> {
    await this.withdraw(request.agentId, "superseded");
    if (request.delayMs <= 0) {
      const row: NudgeRow = { state: "pending", deadline: this.now(), pattern: request.pattern, followUp: request.followUp };
      await this.fire({ request, row, cancelTimer: () => {} });
      return;
    }
    const row: NudgeRow = { state: "pending", deadline: this.now() + request.delayMs, pattern: request.pattern, followUp: request.followUp };
    const entry: Pending = { request, row, cancelTimer: () => {} };
    this.pending.set(request.agentId, entry);
    entry.cancelTimer = (this.options.schedule ?? defaultSchedule)(() => { void this.fireIfPending(request.agentId, entry); }, request.delayMs);
    await request.publish(row);
  }

  has(agentId: string): boolean { return this.pending.has(agentId); }

  /** Withdraws the agent's pending nudge, recording why. Returns whether one was pending. */
  async withdraw(agentId: string, state: "canceled" | "superseded" | "paused"): Promise<boolean> {
    const entry = this.pending.get(agentId);
    if (!entry) return false;
    this.pending.delete(agentId);
    entry.cancelTimer();
    await entry.request.publish({ ...entry.row, state });
    return true;
  }

  /** Sends the agent's pending nudge now. Returns whether one was sent. */
  async sendNow(agentId: string): Promise<boolean> {
    const entry = this.pending.get(agentId);
    if (!entry) return false;
    entry.cancelTimer();
    return this.fireIfPending(agentId, entry);
  }

  async clear(): Promise<void> {
    await Promise.all([...this.pending.keys()].map(agentId => this.withdraw(agentId, "canceled")));
  }

  private async fireIfPending(agentId: string, entry: Pending): Promise<boolean> {
    if (this.pending.get(agentId) !== entry) return false;
    this.pending.delete(agentId);
    return this.fire(entry);
  }

  private async fire({ request, row }: Pending): Promise<boolean> {
    try {
      if (!(await request.stillCurrent())) {
        await request.publish({ ...row, state: "superseded" });
        return false;
      }
      // Mark it sent first: the delivered prompt starts a turn, which withdraws pending nudges.
      await request.publish({ ...row, state: "sent" });
      await request.deliver();
      return true;
    } catch (error) {
      this.options.log?.("[juke] nudge delivery failed", { agentId: request.agentId, error });
      return false;
    }
  }
}

/** Per-agent pauses from /juke-pause. Auto-resume is evaluated lazily from the agent's latest user message. */
export class PauseBook {
  private readonly pausedAt = new Map<string, number>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  pause(agentId: string): void { this.pausedAt.set(agentId, this.now()); }

  resume(agentId: string): boolean { return this.pausedAt.delete(agentId); }

  /**
   * Whether Juke should leave the agent alone. With auto-resume on, the pause lifts once
   * `minutes` pass after the later of the pause and the user's latest message.
   */
  isPaused(agentId: string, lastUserMessageAt: string | null | undefined, autoResume: { enabled: boolean; minutes: number }): boolean {
    const pausedAt = this.pausedAt.get(agentId);
    if (pausedAt === undefined) return false;
    if (!autoResume.enabled) return true;
    const lastUser = lastUserMessageAt ? Date.parse(lastUserMessageAt) : NaN;
    const since = Math.max(pausedAt, Number.isFinite(lastUser) ? lastUser : pausedAt);
    if (this.now() < since + autoResume.minutes * 60_000) return true;
    this.pausedAt.delete(agentId);
    return false;
  }
}
