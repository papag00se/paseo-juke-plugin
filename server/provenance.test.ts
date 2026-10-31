import { describe, expect, it } from "vitest";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { classifySubagentMessages, commandContains, normalizeMessage, promptSends, similarity, type TimelineEntry } from "./provenance";
import { evidence } from "./judge";

const user = (text: string, timestamp?: string): TimelineEntry => ({ item: { type: "user_message", text }, timestamp });
const send = (input: unknown, name = "paseo.send_agent_prompt", status = "completed", timestamp?: string): TimelineEntry => ({
  item: { type: "tool_call", callId: "c", name, status, error: status === "failed" ? "x" : null, detail: { type: "unknown", input } } as AgentTimelineItem,
  timestamp,
});
const child = (sends: { text: string; timestamp?: string }[], createdAt = "2026-10-28T18:00:00.000Z") => ({ id: "child", title: "Worker", createdAt, sends });

describe("normalized similarity", () => {
  it("ignores escaping, whitespace and case", () => {
    expect(normalizeMessage('Done: \\"ok\\"\\n  next   STEP')).toBe('done: "ok" next step');
    expect(similarity('I will not touch "Dependabot".', 'I will not  touch \\"Dependabot\\".')).toBe(1);
  });

  it("tolerates a small edit but not a different message", () => {
    const report = "R9 finished: 1803 byte/length/Git-mode matches, exact review requested before integration.";
    expect(similarity(report, report.replace("exact", "exactt"))).toBeGreaterThanOrEqual(0.9);
    expect(similarity(report, "Please keep working through the remaining ownership plan items.")).toBeLessThan(0.9);
    expect(similarity(report, report.slice(0, 30))).toBe(0);
  });
});

describe("promptSends", () => {
  it("reads gateway-wrapped and native tool calls addressed to the parent", () => {
    const sends = promptSends([
      send({ tool: "paseo_send_agent_prompt", args: { agentId: "parent", prompt: "wrapped" } }, "paseo.send_agent_prompt"),
      send({ agentId: "parent", prompt: "native" }, "mcp__paseo__send_agent_prompt"),
      send(JSON.stringify({ agentId: "parent", prompt: "stringified" }), "send_agent_prompt"),
      send({ agentId: "someone-else", prompt: "elsewhere" }, "send_agent_prompt"),
      send({ agentId: "parent", prompt: "failed" }, "send_agent_prompt", "failed"),
      send({ agentId: "parent", prompt: "not a send" }, "paseo.create_agent"),
    ], "parent");
    expect(sends.map(s => s.text)).toEqual(["wrapped", "native", "stringified"]);
  });

  it("reads CLI sends to the parent from shell commands", () => {
    const shell = (command: string): TimelineEntry => ({ item: { type: "tool_call", callId: "s", name: "bash", status: "completed", error: null, detail: { type: "shell", command } } as AgentTimelineItem });
    const sends = promptSends([
      shell(`for id in parent other; do paseo send "$id" 'Report' --no-wait; done`),
      shell("paseo send other 'Report'"),
      shell("echo parent"),
    ], "parent");
    expect(sends).toEqual([{ text: `for id in parent other; do paseo send "$id" 'Report' --no-wait; done`, timestamp: undefined, via: "shell" }]);
  });
});

describe("commandContains", () => {
  const message = "URGENT R6 INCOMPLETE; do not approve: it's not the real receipt, see RESULT.md for the evidence.";
  it("finds a shell-quoted prompt inside the command", () => {
    expect(commandContains(`paseo send parent '${message.replace("'", "'\\''")}' --no-wait`, message)).toBe(true);
    expect(commandContains(`paseo send parent '${message.replace("evidence", "evidense")}'`, message)).toBe(true);
  });
  it("does not match short or unrelated messages", () => {
    expect(commandContains(`paseo send parent 'Status report: still running'`, "Status report")).toBe(false);
    expect(commandContains(`paseo send parent 'Something else entirely that is long enough to compare.'`, message)).toBe(false);
  });
});

describe("classifySubagentMessages", () => {
  const report = "Coordination notice received: I am child, not editing candidate files.";

  it("pairs a send with a delivered message despite millisecond and escaping drift", () => {
    const parent = [user("Keep going.", "2026-10-28T18:10:00.000Z"), user(report.replace(", not", ",\n not"), "2026-10-28T18:22:47.770Z")];
    expect([...classifySubagentMessages(parent, [child([{ text: report, timestamp: "2026-10-28T18:22:45.532Z" }])]).keys()]).toEqual([1]);
  });

  it("accepts a rehydrated send stamped later than delivery but rejects messages before the child existed", () => {
    const parent = [user(report, "2026-10-28T17:00:00.000Z"), user(report, "2026-10-28T18:22:47.770Z")];
    const result = classifySubagentMessages(parent, [child([{ text: report, timestamp: "2026-10-31T16:31:46.399Z" }])]);
    expect([...result.keys()]).toEqual([1]);
  });

  it("rejects deliveries far beyond the window after the send", () => {
    const parent = [user(report, "2026-10-30T18:22:47.770Z")];
    expect(classifySubagentMessages(parent, [child([{ text: report, timestamp: "2026-10-28T18:22:45.532Z" }])]).size).toBe(0);
  });

  it("matches repeated reports in order, one message per send", () => {
    const parent = [user(report, "2026-10-28T18:01:00.000Z"), user("Status report", "2026-10-28T18:02:00.000Z"), user(report, "2026-10-28T18:03:00.000Z"), user(report, "2026-10-28T18:04:00.000Z")];
    const result = classifySubagentMessages(parent, [child([{ text: report, timestamp: "2026-10-28T18:00:59.000Z" }, { text: report, timestamp: "2026-10-28T18:02:59.000Z" }])]);
    expect([...result.keys()]).toEqual([0, 2]);
  });

  it("pairs a CLI send with the delivered message", () => {
    const text = "Independent review complete: BLOCK, report saved under tmp/ownership-watch/review.md.";
    const parent = [user("Keep going.", "2026-10-28T18:10:00.000Z"), user(text, "2026-10-28T18:30:00.000Z")];
    const result = classifySubagentMessages(parent, [child([{ text: `paseo send parent '${text}' --no-wait`, timestamp: "2026-10-28T18:29:58.000Z", via: "shell" }])]);
    expect([...result.keys()]).toEqual([1]);
  });

  it("leaves an unmatched human message as possible user direction in judge evidence", () => {
    const parent = [user("Keep going with the whole plan."), user(report)];
    const reports = classifySubagentMessages(parent, [child([{ text: report }])]);
    const items = JSON.parse(evidence(parent.map(e => e.item), reports)).items;
    expect(items).toEqual([
      { type: "user_message", text: "Keep going with the whole plan." },
      { type: "subagent_report", fromAgentId: "child", fromTitle: "Worker", text: report },
    ]);
  });
});
