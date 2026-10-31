import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { JukeJudgeLabel } from "./judge";

/** An incomplete directory must never be mistaken for an idle agent tree. */
async function agents(paseo: PaseoApi): Promise<PaseoAgent[]> {
  const result: PaseoAgent[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await paseo.agents.list({ page: { limit: 200, cursor } });
    result.push(...page.entries.map(entry => entry.agent));
    if (!page.pageInfo.hasMore) break;
    cursor = page.pageInfo.nextCursor ?? undefined;
    if (!cursor || seen.has(cursor)) throw new Error("Incomplete agent directory");
    seen.add(cursor);
  } while (cursor);
  return result;
}

export function genuinelyIdle(agent: PaseoAgent | undefined): boolean {
  return !!agent && !agent.archivedAt && agent.status === "idle" && !agent.activeTurn && !agent.pendingPermissions?.length;
}

/** Include descendants, not only immediate children; a running grandchild still has work in flight. */
export async function idleDelegation(paseo: PaseoApi, parentId: string): Promise<{ parent: PaseoAgent; children: PaseoAgent[] } | null> {
  const all = await agents(paseo);
  const parent = all.find(agent => agent.id === parentId);
  if (!genuinelyIdle(parent)) return null;
  const children: PaseoAgent[] = [];
  const ids = new Set([parentId]);
  for (let old = -1; old !== ids.size;) {
    old = ids.size;
    for (const agent of all) {
      if (agent.archivedAt || agent.labels?.[JukeJudgeLabel] || ids.has(agent.id)) continue;
      const parent = getParentAgentIdFromLabels(agent.labels);
      if (parent && ids.has(parent)) { ids.add(agent.id); children.push(agent); }
    }
  }
  if (!children.length || children.some(child => !["idle", "error", "closed"].includes(child.status) || child.activeTurn || child.pendingPermissions?.length)) return null;
  return { parent: parent!, children };
}

/** Fetch the parent's full conversation so older user intent isn't lost to tail pagination. */
export async function parentTimeline(paseo: PaseoApi, parentId: string): Promise<AgentTimelineItem[]> {
  const timeline = paseo.agents.ref(parentId).timeline;
  let page = await timeline.refetch({ direction: "tail", projection: "canonical", limit: 200 });
  const entries = [...page.entries];
  const seen = new Set<string>();
  while (page.hasOlder) {
    if (page.error) throw new Error(page.error);
    const cursor = page.startCursor;
    const key = cursor && JSON.stringify(cursor);
    if (!cursor || !key || seen.has(key)) throw new Error("Incomplete parent timeline");
    seen.add(key);
    page = await timeline.refetch({ direction: "before", cursor, projection: "canonical", limit: 200 });
    entries.unshift(...page.entries);
  }
  if (page.error) throw new Error(page.error);
  return entries.map(entry => entry.item);
}

/** Latest child outputs are evidence, not instructions to the judge. */
export async function childEvidence(paseo: PaseoApi, children: PaseoAgent[], triggeringChildId: string): Promise<string> {
  const triggering = children.find(child => child.id === triggeringChildId);
  const selected = [...children.filter(child => child.id !== triggeringChildId).slice(-19), ...(triggering ? [triggering] : [])];
  const summaries = await Promise.all(selected.map(async child => {
    const page = await paseo.agents.ref(child.id).timeline.refetch({ direction: "tail", projection: "canonical", limit: 30 });
    if (page.error) throw new Error(page.error);
    const last = page.entries.map(entry => entry.item).findLast(item => item.type === "assistant_message");
    return { id: child.id, title: child.title, status: child.status, error: child.lastError ?? null, result: last?.type === "assistant_message" ? last.text.slice(-2000) : null };
  }));
  return JSON.stringify({ omittedChildren: children.length - selected.length, children: summaries });
}
