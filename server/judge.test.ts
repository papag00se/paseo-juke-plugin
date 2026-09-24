import { describe, expect, it } from "vitest";
import { isJukeFollowUp, JukeFollowUpPrefix, parseVerdict } from "./judge";
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

  it("rejects an empty rationale", () => {
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
