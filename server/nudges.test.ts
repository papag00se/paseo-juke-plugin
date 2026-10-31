import { describe, expect, it } from "vitest";
import type { NudgeRow } from "../shared/nudge";
import { NudgeQueue, PauseBook } from "./nudges";

function harness() {
  let now = 1_000_000;
  const timers: { at: number; run: () => void; canceled: boolean }[] = [];
  const queue = new NudgeQueue({
    now: () => now,
    schedule: (run, delay) => { const timer = { at: now + delay, run, canceled: false }; timers.push(timer); return () => { timer.canceled = true; }; },
  });
  const rows: NudgeRow["state"][] = [];
  const delivered: string[] = [];
  let current = true;
  const request = (agentId: string, delayMs = 15_000) => ({
    agentId, pattern: "stopped-at-next-steps", followUp: `continue ${agentId}`, delayMs,
    publish: async (row: NudgeRow) => { rows.push(row.state); },
    deliver: async () => { delivered.push(agentId); },
    stillCurrent: async () => current,
  });
  const advance = async (ms: number) => {
    now += ms;
    for (const timer of timers.filter(timer => !timer.canceled && timer.at <= now)) { timer.canceled = true; timer.run(); }
    await new Promise(resolve => setImmediate(resolve));
  };
  return { queue, rows, delivered, request, advance, setCurrent: (value: boolean) => { current = value; } };
}

describe("NudgeQueue", () => {
  it("shows a countdown and sends only after the delay", async () => {
    const h = harness();
    await h.queue.enqueue(h.request("a"));
    await h.advance(14_999);
    expect(h.delivered).toEqual([]);
    await h.advance(1);
    expect(h.delivered).toEqual(["a"]);
    expect(h.rows).toEqual(["pending", "sent"]);
  });

  it.each([
    ["Cancel", (q: NudgeQueue) => q.withdraw("a", "canceled"), "canceled"],
    ["a new turn", (q: NudgeQueue) => q.withdraw("a", "superseded"), "superseded"],
    ["a pause", (q: NudgeQueue) => q.withdraw("a", "paused"), "paused"],
  ] as const)("withdraws on %s and never sends", async (_, withdraw, state) => {
    const h = harness();
    await h.queue.enqueue(h.request("a"));
    expect(await withdraw(h.queue)).toBe(true);
    await h.advance(60_000);
    expect(h.delivered).toEqual([]);
    expect(h.rows).toEqual(["pending", state]);
  });

  it("sends immediately on Send now, once", async () => {
    const h = harness();
    await h.queue.enqueue(h.request("a"));
    expect(await h.queue.sendNow("a")).toBe(true);
    await h.advance(60_000);
    expect(await h.queue.sendNow("a")).toBe(false);
    expect(h.delivered).toEqual(["a"]);
  });

  it("does not send a nudge that went stale while waiting", async () => {
    const h = harness();
    await h.queue.enqueue(h.request("a"));
    h.setCurrent(false);
    await h.advance(15_000);
    expect(h.delivered).toEqual([]);
    expect(h.rows).toEqual(["pending", "superseded"]);
  });

  it("replaces an agent's older pending nudge and sends a zero-delay nudge at once", async () => {
    const h = harness();
    await h.queue.enqueue(h.request("a"));
    await h.queue.enqueue(h.request("a", 0));
    await h.advance(60_000);
    expect(h.delivered).toEqual(["a"]);
    expect(h.rows).toEqual(["pending", "superseded", "sent"]);
  });
});

describe("PauseBook", () => {
  const minutes = (n: number) => n * 60_000;
  it("auto-resumes a set time after the later of the pause and the user's latest message", () => {
    let now = Date.parse("2026-10-31T12:00:00Z");
    const book = new PauseBook(() => now);
    book.pause("a");
    const autoResume = { enabled: true, minutes: 5 };
    now += minutes(3);
    const lastUser = new Date(now).toISOString();
    now += minutes(4);
    expect(book.isPaused("a", lastUser, autoResume)).toBe(true);
    now += minutes(1);
    expect(book.isPaused("a", lastUser, autoResume)).toBe(false);
    expect(book.isPaused("a", null, autoResume)).toBe(false);
  });

  it("stays paused until /juke-resume when auto-resume is off", () => {
    let now = 0;
    const book = new PauseBook(() => now);
    book.pause("a");
    now += minutes(600);
    expect(book.isPaused("a", null, { enabled: false, minutes: 5 })).toBe(true);
    expect(book.resume("a")).toBe(true);
    expect(book.isPaused("a", null, { enabled: false, minutes: 5 })).toBe(false);
    expect(book.isPaused("b", null, { enabled: false, minutes: 5 })).toBe(false);
  });
});
