import { describe, expect, it } from "vitest";
import { isDelegatedAgent } from "@getpaseo/protocol/agent-labels";
import { evidence, isJukeFollowUp, JukeFollowUpPrefix, judgeLabels, parseVerdict } from "./judge";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";

describe("parseVerdict", () => {
  it("accepts a bare verdict object", () => {
    expect(parseVerdict('{"decision":"leave-alone","rationale":"nothing to do"}')).toEqual({
      decision: "leave-alone",
      rationale: "nothing to do",
    });
  });

  it("accepts a fenced verdict", () => {
    const text = '```json\n{"decision":"continue","rationale":"r","followUp":"do it"}\n```';
    expect(parseVerdict(text)?.followUp).toBe("do it");
  });

  // Judges routinely narrate around the verdict; discarding those replies silently dropped
  // roughly half of all verdicts before the balanced-brace scan existed.
  it("recovers a verdict wrapped in prose", () => {
    const text = 'Here is my verdict:\n{"decision":"continue","rationale":"r","followUp":"f"}\nHope that helps.';
    expect(parseVerdict(text)?.decision).toBe("continue");
  });

  it("recovers a verdict followed by a trailing sentence", () => {
    expect(parseVerdict('{"decision":"leave-alone","rationale":"done"} — no action needed.')).not.toBeNull();
  });

  it("handles braces and escaped quotes inside strings", () => {
    const text = 'noise {"decision":"leave-alone","rationale":"literal \\" and } inside"} tail';
    expect(parseVerdict(text)?.rationale).toBe('literal " and } inside');
  });

  it("rejects prose with no verdict", () => {
    expect(parseVerdict("The agent finished its work, no action needed.")).toBeNull();
  });

  it("rejects an unknown decision", () => {
    expect(parseVerdict('{"decision":"maybe","rationale":"r"}')).toBeNull();
  });

  it("keeps the judge's pattern classification", () => {
    const text = '{"decision":"continue","pattern":"needless-permission","rationale":"r","followUp":"f"}';
    expect(parseVerdict(text)?.pattern).toBe("needless-permission");
  });

  // pattern is logging-only; a judge inventing a label must not cost us the verdict itself.
  it("drops an unknown pattern without discarding the verdict", () => {
    const verdict = parseVerdict('{"decision":"continue","pattern":"other","rationale":"r","followUp":"f"}');
    expect(verdict?.decision).toBe("continue");
    expect(verdict?.pattern).toBeUndefined();
  });

  // Seen live: a judge answered a bare leave-alone, which used to force a retry round-trip.
  it("accepts leave-alone without a rationale", () => {
    expect(parseVerdict('{"decision":"leave-alone"}')?.decision).toBe("leave-alone");
  });

  it("rejects a continue with an empty rationale", () => {
    expect(parseVerdict('{"decision":"continue","rationale":""}')).toBeNull();
  });
});

describe("isJukeFollowUp", () => {
  const user = (text: string): AgentTimelineItem => ({ type: "user_message", text });
  const assistant = (text: string): AgentTimelineItem => ({ type: "assistant_message", text });

  // Without this guard Juke would judge its own nudge and nudge again, forever.
  it("detects its own follow-up as the latest user message", () => {
    expect(isJukeFollowUp([user("fix the bug"), assistant("ok"), user(`${JukeFollowUpPrefix} carry on`)])).toBe(true);
  });

  it("ignores an earlier follow-up once the user speaks again", () => {
    expect(isJukeFollowUp([user(`${JukeFollowUpPrefix} carry on`), assistant("done"), user("now do this")])).toBe(false);
  });

  it("is false when no user message exists", () => {
    expect(isJukeFollowUp([assistant("hello")])).toBe(false);
  });
});

describe("judge evidence", () => {
  const user = (text: string): AgentTimelineItem => ({ type: "user_message", text });
  const assistant = (text: string): AgentTimelineItem => ({ type: "assistant_message", text });
  const tool = (detail: unknown): AgentTimelineItem => ({
    type: "tool_call", callId: "review", name: "read", status: "completed", error: null, detail,
  }) as AgentTimelineItem;

  it("preserves the outstanding request across image review and an interrupting status check", () => {
    const binary = "base64-payload-".repeat(20_000);
    const result = evidence([
      user("Clearly I wanted you to act. Fill out all 45 creator cards."),
      assistant("I'll fill the cards with verified data and mark gaps."),
      tool({ type: "unknown", output: { content: [{ type: "image", data: binary, mimeType: "image/jpeg" }] } }),
      user("Status report"),
      assistant("Images and captions saved. Still finishing individual creator cards."),
    ]);
    const parsed = JSON.parse(result);
    expect(parsed.items.filter((item: { type: string }) => item.type === "user_message").map((item: { text: string }) => item.text))
      .toEqual(["Clearly I wanted you to act. Fill out all 45 creator cards.", "Status report"]);
    expect(result).toContain("Still finishing individual creator cards");
    expect(result).not.toContain("base64-payload-");
    expect(result.length).toBeLessThanOrEqual(48_000);
  });

  it("keeps conversation ahead of large textual tool output and restores chronology", () => {
    const timeline = [user("Complete the local records; do not publish."),
      ...Array.from({ length: 80 }, () => tool({ type: "unknown", output: "noise".repeat(10_000) })),
      user("Status report"), assistant("The records are still incomplete.")];
    const result = evidence(timeline);
    const parsed = JSON.parse(result);
    expect(result.length).toBeLessThanOrEqual(48_000);
    expect(parsed.omittedItems).toBeGreaterThan(0);
    expect(parsed.items[0].text).toBe("Complete the local records; do not publish.");
    expect(parsed.items.slice(-2).map((item: { text: string }) => item.text))
      .toEqual(["Status report", "The records are still incomplete."]);
  });

  it("retains the latest response even when earlier user messages exhaust the budget", () => {
    const timeline = [
      ...Array.from({ length: 20 }, (_, index) => user(`earlier ${index}: ` + "x".repeat(8_000))),
      user("Status report"), assistant("Local cards are still unfinished."),
    ];
    const parsed = JSON.parse(evidence(timeline));
    expect(parsed.omittedItems).toBeGreaterThan(0);
    expect(parsed.items.slice(-2).map((item: { text: string }) => item.text))
      .toEqual(["Status report", "Local cards are still unfinished."]);
  });

  it("bounds oversized messages and escaped strings without producing broken JSON", () => {
    const result = evidence([user("opening request " + '\\"'.repeat(100_000) + " final boundary"), assistant("Not done.")]);
    const parsed = JSON.parse(result);
    expect(result.length).toBeLessThanOrEqual(48_000);
    expect(parsed.items[0].text).toMatch(/^opening request /);
    expect(parsed.items[0].text).toMatch(/ final boundary$/);
    expect(parsed.items[0].text).toContain("text omitted");
  });
});

describe("judgeLabels", () => {
  // The daemon skips notifications for agents that satisfy this exact predicate. If the judge
  // stops qualifying, every judgement raises an OS notification again.
  it("marks the judge as delegated so the daemon never notifies for it", () => {
    expect(isDelegatedAgent({ labels: judgeLabels("agent-1") })).toBe(true);
  });
});
