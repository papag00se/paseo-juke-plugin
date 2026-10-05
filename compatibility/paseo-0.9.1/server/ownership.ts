import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";

/**
 * Role Orchestration runs its own completion gate. Judging those agents twice would let two
 * independent judges push conflicting follow-ups into the same turn, so Juke stays out of any
 * run the orchestrator owns — the role agent itself, its helpers, and anything beneath them.
 */
const ROLE_ORCHESTRATOR_LABELS = [
  "paseo-role-orchestrator.role-id",
  "paseo-role-orchestrator.completion-gate",
  "paseo-role-orchestrator.context-helper",
];

const MAX_ANCESTRY_DEPTH = 8;

export interface LabelledAgent {
  labels?: Record<string, string>;
}

/** Minimal view of the SDK needed to walk a parent chain, so tests need no daemon. */
export interface AgentLookup {
  agents: {
    ref(agentId: string): { refresh(): Promise<{ agent?: LabelledAgent } | null | undefined> };
  };
}

export function hasRoleOrchestratorLabel(labels: Record<string, string> | null | undefined): boolean {
  if (!labels) return false;
  return ROLE_ORCHESTRATOR_LABELS.some((label) => label in labels);
}

/**
 * A subagent carries no role label of its own, so ownership is decided by walking the parent
 * chain. The depth bound and visited set keep a corrupted or cyclic chain from stalling the
 * turn-ended handler.
 */
export async function isRoleOrchestrated(
  paseo: AgentLookup,
  agent: LabelledAgent | undefined,
): Promise<boolean> {
  let current = agent;
  const seen = new Set<string>();
  for (let depth = 0; current && depth < MAX_ANCESTRY_DEPTH; depth += 1) {
    if (hasRoleOrchestratorLabel(current.labels)) return true;
    const parentId = getParentAgentIdFromLabels(current.labels);
    if (!parentId || seen.has(parentId)) return false;
    seen.add(parentId);
    current = (await paseo.agents.ref(parentId).refresh())?.agent;
  }
  return false;
}
