import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Ask } from "./judge";

/**
 * One long-lived judge session per judged agent, plus that agent's ask ledger.
 *
 * Providers cache by exact prompt prefix. A judge that keeps its own conversation and only
 * appends what happened since its last verdict pays for that delta, not the whole history.
 * The ledger keeps the user's asks once the agent's own context has been compacted, and
 * seeds the next judge session when this one is rotated.
 */
export interface JudgeSession {
  judgeId: string | null;
  /** The judge's "provider/model", thinking level and instructions; any change starts a new session. */
  key: string | null;
  /** Timeline items of the judged agent the judge has already seen. */
  judgedItems: number;
  /** Characters sent into the current judge session, to rotate it before it grows unwieldy. */
  sentChars: number;
  ledger: Ask[];
}

/** Rotate before a judge session approaches small context windows (roughly 100k tokens). */
export const RotateAfterChars = 400_000;
/** A replacement judge session sees the ledger plus this many of the latest timeline items. */
export const RecentItemsOnRestart = 60;
const MaxLedgerItems = 60;

const storePath = () => join(process.env.PASEO_HOME || join(homedir(), ".paseo"), "plugin-data", "juke-sessions.json");

export class JudgeSessions {
  private sessions = new Map<string, JudgeSession>();
  private loaded: Promise<void> | null = null;
  private writing = Promise.resolve();
  private locks = new Map<string, Promise<void>>();

  load(): Promise<void> {
    this.loaded ??= (async () => {
      try {
        const raw = JSON.parse(await readFile(storePath(), "utf8")) as Record<string, JudgeSession>;
        for (const [agentId, session] of Object.entries(raw ?? {})) {
          if (session && typeof session === "object") this.sessions.set(agentId, { judgeId: session.judgeId ?? null, key: session.key ?? null, judgedItems: session.judgedItems ?? 0, sentChars: session.sentChars ?? 0, ledger: Array.isArray(session.ledger) ? session.ledger : [] });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error("[juke] judge sessions unreadable; starting fresh", error);
      }
    })();
    return this.loaded;
  }

  judgeIds(): string[] {
    return [...this.sessions.values()].flatMap((session) => session.judgeId ? [session.judgeId] : []);
  }

  get(agentId: string): JudgeSession {
    return this.sessions.get(agentId) ?? { judgeId: null, key: null, judgedItems: 0, sentChars: 0, ledger: [] };
  }

  async put(agentId: string, session: JudgeSession): Promise<void> {
    this.sessions.set(agentId, session);
    const snapshot = JSON.stringify(Object.fromEntries(this.sessions), null, 1);
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(storePath()), { recursive: true });
      const temporary = `${storePath()}.tmp-${process.pid}-${randomUUID()}`;
      await writeFile(temporary, snapshot);
      await rename(temporary, storePath());
    }).catch((error) => console.error("[juke] could not save judge sessions", error));
    await this.writing;
  }

  /** A judge session handles one message at a time, so assessments of one agent run in order. */
  async exclusive<T>(agentId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(agentId) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => { release = resolve; });
    const chained = previous.then(() => mine);
    this.locks.set(agentId, chained);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.locks.get(agentId) === chained) this.locks.delete(agentId);
    }
  }
}

/**
 * The judge rewrites the ledger each verdict. An item it silently dropped is kept, so a ledger can
 * only shrink by the judge marking items done or blocked, not by omission or truncation.
 */
export function mergeLedger(previous: readonly Ask[], next: readonly Ask[] | undefined): Ask[] {
  if (!next) return [...previous];
  const seen = new Set(next.map((ask) => ask.item.toLowerCase()));
  const kept = previous.filter((ask) => ask.status === "open" && !seen.has(ask.item.toLowerCase()));
  return [...next, ...kept].slice(0, MaxLedgerItems);
}
