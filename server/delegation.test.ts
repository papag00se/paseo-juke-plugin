import { describe, expect, it, vi } from "vitest";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { originalAutomaticContribution } from "../index.server";
import { JukeIds } from "../shared/jukes";
import { idleDelegation } from "./delegation";

const parentLabel = "paseo.parent-agent-id";
const agent = (id: string, parent?: string, status = "idle") => ({
  id, status, provider: "pi", model: "model", cwd: "/repo", workspaceId: "ws", title: id,
  archivedAt: null, activeTurn: null, pendingPermissions: [], labels: parent ? { [parentLabel]: parent } : {},
});
const event = (id: string, parent: string | null) => ({
  agent: { ...agent(id), parentAgentId: parent }, turnId: `turn-${id}`, outcome: { kind: "failed", error: { message: "finished" } }, timeline: [],
});
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };

function harness(options: { disabled?: boolean; judgeWait?: Promise<any> } = {}) {
  const hooks = new Map<string, Function>();
  const list = [agent("parent"), agent("one", "parent"), agent("two", "parent")];
  const sent: string[] = [], prompts: string[] = [];
  const paseo = {
    agents: {
      list: vi.fn(async () => ({ entries: list.map(agent => ({ agent })), pageInfo: { hasMore: false } })),
      ref: (id: string) => ({
        refresh: async () => ({ agent: list.find(a => a.id === id) }),
        send: async (text: string) => { sent.push(text); },
        archive: async () => ({}),
        timeline: { refetch: async () => ({ entries: [{ item: id === "parent" ? { type: "user_message", text: "Finish all the work" } : { type: "assistant_message", text: `Result from ${id}: work remains` } }], hasOlder: false }) },
      }),
    },
    workspaces: { ref: () => ({ agents: { create: async (input: any) => {
      prompts.push(input.prompt);
      return { id: "judge", waitForFinish: async () => options.judgeWait ?? { status: "idle", lastMessage: JSON.stringify({ decision: "continue", pattern: "abandoned-after-delegation", rationale: "Results need review", followUp: "Review the delegated results and finish the work." }) } };
    } } }) },
  };
  const server = { on: (name: string, handler: Function) => { hooks.set(name, handler); return () => hooks.delete(name); } } as unknown as PluginServerContext;
  const stop = originalAutomaticContribution(server, async () => ({ enabled: true, jukes: options.disabled ? JukeIds.filter(id => id !== "abandoned-after-delegation") : JukeIds, revision: "one" }));
  const fire = (id = "two", parent = "parent") => hooks.get("agent.turn_ended")!(event(id, parent), { paseo });
  const start = (id = "one") => hooks.get("agent.turn_started")!({ agent: { ...agent(id), parentAgentId: "parent" }, turnId: "new" }, { paseo });
  return { list, paseo, sent, prompts, fire, start, stop };
}

describe("delegation completion", () => {
  it("assesses the idle parent with child results when the last child finishes", async () => {
    const h = harness(); h.list[1].status = "running";
    h.fire(); await flush(); expect(h.prompts).toHaveLength(0);
    h.list[1].status = "idle"; h.fire("one"); await flush();
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0]).toContain("Finish all the work");
    expect(h.prompts[0]).toContain("Result from one: work remains");
    expect(h.prompts[0]).toMatch(/^1\. abandoned-after-delegation:/m);
    expect(h.sent).toHaveLength(1);
    h.stop();
  });
  it("does nothing when the new juke is off or the parent has a permission pending", async () => {
    const off = harness({ disabled: true }); off.fire(); await flush(); expect(off.prompts).toHaveLength(0); off.stop();
    const waiting = harness(); (waiting.list[0].pendingPermissions as any[]).push({ id: "permission" });
    waiting.fire(); await flush(); expect(waiting.prompts).toHaveLength(0); waiting.stop();
  });
  it("discards a verdict if a child resumes while the judge is working", async () => {
    let resolve!: (value: any) => void;
    const judgeWait = new Promise<any>(done => { resolve = done; });
    const h = harness({ judgeWait }); h.fire(); await flush(); expect(h.prompts).toHaveLength(1);
    h.start(); h.list[1].status = "running";
    resolve({ status: "idle", lastMessage: JSON.stringify({ decision: "continue", pattern: "abandoned-after-delegation", rationale: "Work remains", followUp: "Continue" }) });
    await flush(); expect(h.sent).toEqual([]); h.stop();
  });
  it("does not wake a parent when a child was canceled or the parent is running", async () => {
    const h = harness();
    h.list[0].status = "running"; h.fire(); await flush(); expect(h.prompts).toHaveLength(0);
    h.list[0].status = "idle";
    const canceled = event("one", "parent"); (canceled as any).outcome = { kind: "canceled", reason: "user stopped" };
    // Exercise the same lifecycle handler with a fresh turn ID.
    h.stop();
    const callbacks = new Map<string, Function>();
    const server = { on: (name: string, fn: Function) => { callbacks.set(name, fn); return () => {}; } } as unknown as PluginServerContext;
    const stop = originalAutomaticContribution(server);
    callbacks.get("agent.turn_ended")!(canceled, { paseo: h.paseo }); await flush();
    expect(h.prompts).toHaveLength(0); stop();
  });
  it("only assesses once for a duplicate child completion event", async () => {
    const h = harness(); h.fire(); await flush(); h.fire(); await flush();
    expect(h.prompts).toHaveLength(1); expect(h.sent).toHaveLength(1); h.stop();
  });
  it("rechecks the root when its last grandchild finishes", async () => {
    const h = harness(); h.list.push(agent("grandchild", "one"));
    h.fire("grandchild", "one"); await flush();
    expect(h.prompts).toHaveLength(2);
    expect(h.prompts.every(prompt => prompt.includes("Result from grandchild"))).toBe(true);
    h.stop();
  });
  it("does not overlook an active grandchild or an incomplete paginated directory", async () => {
    const h = harness(); h.list.push(agent("grandchild", "one", "running"));
    expect(await idleDelegation(h.paseo as any, "parent")).toBeNull();
    h.paseo.agents.list.mockResolvedValue({ entries: [], pageInfo: { hasMore: true } } as any);
    await expect(idleDelegation(h.paseo as any, "parent")).rejects.toThrow("Incomplete agent directory"); h.stop();
  });
});
