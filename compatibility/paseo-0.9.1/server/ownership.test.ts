import { describe, expect, it } from "vitest";
import { hasRoleOrchestratorLabel, isRoleOrchestrated, type AgentLookup, type LabelledAgent } from "./ownership";

const PARENT = "paseo.parent-agent-id";

/** In-memory agent graph so the ancestry walk is exercised without a daemon. */
function lookup(agents: Record<string, LabelledAgent>): AgentLookup & { refreshes: string[] } {
  const refreshes: string[] = [];
  return {
    refreshes,
    agents: {
      ref(agentId: string) {
        return {
          async refresh() {
            refreshes.push(agentId);
            const agent = agents[agentId];
            return agent ? { agent } : null;
          },
        };
      },
    },
  };
}

describe("hasRoleOrchestratorLabel", () => {
  it.each([
    ["role agent", { "paseo-role-orchestrator.role-id": "r1" }],
    ["completion gate", { "paseo-role-orchestrator.completion-gate": "judge" }],
    ["context helper", { "paseo-role-orchestrator.context-helper": "true" }],
  ])("claims a %s", (_name, labels) => {
    expect(hasRoleOrchestratorLabel(labels)).toBe(true);
  });

  it.each([
    ["an ordinary agent", { surface: "workspace" }],
    ["an unlabelled agent", undefined],
    ["a plain subagent", { [PARENT]: "abc" }],
  ])("does not claim %s", (_name, labels) => {
    expect(hasRoleOrchestratorLabel(labels)).toBe(false);
  });
});

describe("isRoleOrchestrated", () => {
  it("skips a role agent directly", async () => {
    const api = lookup({});
    expect(await isRoleOrchestrated(api, { labels: { "paseo-role-orchestrator.role-id": "r1" } })).toBe(true);
    expect(api.refreshes).toEqual([]);
  });

  // The case that matters: a subagent carries no role label of its own.
  it("skips a subagent whose parent is a role agent", async () => {
    const api = lookup({ parent: { labels: { "paseo-role-orchestrator.role-id": "r1" } } });
    expect(await isRoleOrchestrated(api, { labels: { [PARENT]: "parent" } })).toBe(true);
  });

  it("skips a grandchild of a role agent", async () => {
    const api = lookup({
      mid: { labels: { [PARENT]: "root" } },
      root: { labels: { "paseo-role-orchestrator.role-id": "r1" } },
    });
    expect(await isRoleOrchestrated(api, { labels: { [PARENT]: "mid" } })).toBe(true);
  });

  it("judges an ordinary agent and its subagents", async () => {
    const api = lookup({ parent: { labels: { surface: "workspace" } } });
    expect(await isRoleOrchestrated(api, { labels: { [PARENT]: "parent" } })).toBe(false);
  });

  it("stops when an ancestor is missing", async () => {
    const api = lookup({});
    expect(await isRoleOrchestrated(api, { labels: { [PARENT]: "gone" } })).toBe(false);
  });

  // A cyclic chain must not hang the turn-ended handler.
  it("terminates on a parent cycle", async () => {
    const api = lookup({ a: { labels: { [PARENT]: "b" } }, b: { labels: { [PARENT]: "a" } } });
    expect(await isRoleOrchestrated(api, { labels: { [PARENT]: "a" } })).toBe(false);
    expect(api.refreshes.length).toBeLessThanOrEqual(8);
  });

  it("bounds a very deep chain", async () => {
    const agents: Record<string, LabelledAgent> = {};
    for (let i = 0; i < 50; i += 1) agents[`a${i}`] = { labels: { [PARENT]: `a${i + 1}` } };
    const api = lookup(agents);
    expect(await isRoleOrchestrated(api, { labels: { [PARENT]: "a0" } })).toBe(false);
    expect(api.refreshes.length).toBeLessThanOrEqual(8);
  });
});
