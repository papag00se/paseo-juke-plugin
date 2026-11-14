import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Paseo records a durable "tell the caller when this child finishes" entry and removes it only
 * after the notification has been handed to the caller. Its presence therefore means the
 * caller's own wake-up is still on its way, and its disappearance means the caller's next turn
 * is about to start. Plugins get no event for this, so the store is read directly.
 * (The same module is mirrored in the Role Orchestrator plugin; keep them in step.)
 */
const storePath = () => join(process.env.PASEO_HOME || join(homedir(), ".paseo"), "finish-subscriptions.json");

export interface FinishNotificationTiming {
  /** How often a still-pending notification is re-checked. */
  pollMs: number;
  /** Give up waiting for Paseo's own notification after this long (the slowest seen was ~60 s). */
  maxWaitMs: number;
  /** After the notification is delivered, how long the caller gets to start its turn. */
  graceMs: number;
  /** When the store cannot be read, wait this long instead of guessing it is empty. */
  unreadableWaitMs: number;
}

export const defaultFinishNotificationTiming: FinishNotificationTiming = {
  pollMs: 1_000,
  maxWaitMs: 60_000,
  graceMs: 3_000,
  unreadableWaitMs: 20_000,
};

/** Whether Paseo still owes `callerId` a finish notification for any of `childIds`; undefined if unknowable. */
export async function hasPendingFinishNotification(callerId: string, childIds: Iterable<string>): Promise<boolean | undefined> {
  let records: unknown;
  try {
    records = JSON.parse(await readFile(storePath(), "utf8"));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? false : undefined;
  }
  if (!Array.isArray(records)) return undefined;
  const children = new Set(childIds);
  return records.some((record) => {
    const entry = record as { callerAgentId?: unknown; childAgentId?: unknown } | null;
    return entry?.callerAgentId === callerId && typeof entry.childAgentId === "string" && children.has(entry.childAgentId);
  });
}

const sleep = (ms: number) => (ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

/**
 * Lets Paseo's own child-finished notification reach `callerId` before a plugin nudges it.
 * Waits while the notification is pending, then a short grace for the resulting turn to begin.
 * Returns false when the caller moved on (or the plugin stopped) so the nudge should be dropped.
 */
export async function awaitFinishNotification(options: {
  callerId: string;
  childIds: () => Iterable<string>;
  /** True once the caller resumed or the plugin stopped. */
  superseded: () => boolean;
  timing?: Partial<FinishNotificationTiming>;
}): Promise<boolean> {
  const timing = { ...defaultFinishNotificationTiming, ...options.timing };
  const deadline = Date.now() + timing.maxWaitMs;
  while (!options.superseded()) {
    const pending = await hasPendingFinishNotification(options.callerId, options.childIds());
    if (pending === undefined) {
      await sleep(timing.unreadableWaitMs);
      break;
    }
    if (!pending || Date.now() >= deadline) break;
    await sleep(timing.pollMs);
  }
  if (options.superseded()) return false;
  await sleep(timing.graceMs);
  return !options.superseded();
}
