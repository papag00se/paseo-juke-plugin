import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { JukeJudgeLabel } from "./judge";

/** Paseo labels both human and agent-sent prompts as user messages; it records no sender. */
export type TimelineEntry = { item: AgentTimelineItem; timestamp?: string };
/** `shell` sends carry the whole command; the prompt is located inside it rather than compared whole. */
export type SubagentSend = { text: string; timestamp?: string; via?: "tool" | "shell" };
export type ChildSends = { id: string; title?: string | null; createdAt?: string; sends: SubagentSend[] };
export type SubagentReport = { agentId: string; title: string | null };

export const SimilarityThreshold = 0.9;
/** Clock skew and queueing slack before the child's creation/send. */
const EarlySlackMs = 60_000;
/** A background prompt can wait behind the parent's running turn. */
const DeliveryWindowMs = 6 * 60 * 60_000;

/** Tolerate escaping and whitespace differences between the tool argument and the delivered message. */
export function normalizeMessage(text: string): string {
  return text
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\([nrt"'\\/`])/g, (_, ch: string) => ({ n: " ", r: " ", t: " " } as Record<string, string>)[ch] ?? ch)
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function bigrams(text: string): Map<string, number> {
  const result = new Map<string, number>();
  for (let i = 0; i < text.length - 1; i++) {
    const gram = text.slice(i, i + 2);
    result.set(gram, (result.get(gram) ?? 0) + 1);
  }
  return result;
}

/** Sørensen–Dice over character bigrams of normalized text: linear-time and tolerant of small edits. */
export function similarity(a: string, b: string): number {
  const x = normalizeMessage(a), y = normalizeMessage(b);
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  if (Math.min(x.length, y.length) / Math.max(x.length, y.length) < SimilarityThreshold) return 0;
  const left = bigrams(x), right = bigrams(y);
  let shared = 0;
  for (const [gram, count] of left) shared += Math.min(count, right.get(gram) ?? 0);
  return (2 * shared) / (x.length - 1 + y.length - 1);
}

function record(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try { return record(JSON.parse(value)); } catch { return null; }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/**
 * Providers render the same Paseo tool differently: Pi's MCP gateway wraps it as
 * `{ tool: "paseo_send_agent_prompt", args }`; native MCP clients name it directly.
 */
export function promptSends(entries: readonly TimelineEntry[], parentId: string): SubagentSend[] {
  const sends: SubagentSend[] = [];
  for (const { item, timestamp } of entries) {
    if (item.type !== "tool_call" || item.status === "failed" || item.status === "canceled") continue;
    const detail = item.detail as { type?: string; command?: unknown; input?: unknown } | undefined;
    // Agents also report with the CLI, e.g. `paseo send <parent-id> '...'` (possibly in a loop).
    const command = detail?.type === "shell" ? detail.command : record(detail?.input)?.command;
    if (typeof command === "string" && /\bpaseo\s+(?:agent\s+)?send\b/.test(command) && command.includes(parentId)) {
      sends.push({ text: command, timestamp, via: "shell" });
      continue;
    }
    const input = record(detail?.input);
    if (!input) continue;
    const wrapped = typeof input.tool === "string" ? input.tool : "";
    const tool = `${item.name} ${wrapped}`.toLowerCase().replace(/[^a-z]/g, "_");
    if (!tool.includes("send_agent_prompt")) continue;
    const args = wrapped ? record(input.args) : input;
    if (args?.agentId !== parentId || typeof args.prompt !== "string" || !args.prompt.trim()) continue;
    sends.push({ text: args.prompt, timestamp });
  }
  return sends;
}

/**
 * A shell command contains the prompt plus quoting and other arguments. Anchor on the message's
 * opening or closing words, then compare the aligned span with the same tolerant similarity.
 */
export function commandContains(command: string, message: string): boolean {
  const haystack = normalizeMessage(command.replace(/'\\''/g, "'"));
  const needle = normalizeMessage(message);
  // Short replies such as "yes" or "Status report" could appear in any command by chance.
  if (needle.length < 24) return false;
  if (haystack.includes(needle)) return true;
  const anchor = 20;
  const starts = new Set<number>();
  for (let at = haystack.indexOf(needle.slice(0, anchor)); at >= 0; at = haystack.indexOf(needle.slice(0, anchor), at + 1)) starts.add(at);
  const tail = needle.slice(-anchor);
  for (let at = haystack.indexOf(tail); at >= 0; at = haystack.indexOf(tail, at + 1)) starts.add(Math.max(0, at + anchor - needle.length));
  return [...starts].some(start => similarity(haystack.slice(start, start + needle.length), needle) >= SimilarityThreshold);
}

function time(value: string | undefined | null): number | null {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Pair each child's sends, in order, with the first similar unmatched parent user message in
 * the window. Rehydrated child timelines can restamp entries later than delivery, so the window
 * is anchored at the child's creation and runs generously past the send; a later stamp only widens it.
 */
export function classifySubagentMessages(parent: readonly TimelineEntry[], children: readonly ChildSends[]): Map<number, SubagentReport> {
  const reports = new Map<number, SubagentReport>();
  const candidates = parent.flatMap(({ item, timestamp }, index) => item.type === "user_message" ? [{ index, text: item.text, at: time(timestamp) }] : []);
  for (const child of children) {
    const created = time(child.createdAt);
    let after = -1;
    for (const send of child.sends) {
      const sent = time(send.timestamp);
      const match = candidates.find(candidate => {
        if (candidate.index <= after || reports.has(candidate.index)) return false;
        if (candidate.at !== null) {
          if (created !== null && candidate.at < created - EarlySlackMs) return false;
          if (sent !== null && candidate.at > sent + DeliveryWindowMs) return false;
        }
        return send.via === "shell" ? commandContains(send.text, candidate.text) : similarity(candidate.text, send.text) >= SimilarityThreshold;
      });
      if (!match) continue;
      after = match.index;
      reports.set(match.index, { agentId: child.id, title: child.title ?? null });
    }
  }
  return reports;
}

async function fullTimeline(paseo: PaseoApi, agentId: string): Promise<TimelineEntry[]> {
  const timeline = paseo.agents.ref(agentId).timeline;
  let page = await timeline.refetch({ direction: "tail", projection: "canonical", limit: 200 });
  const entries = [...page.entries];
  const seen = new Set<string>();
  while (page.hasOlder) {
    if (page.error) throw new Error(page.error);
    const cursor = page.startCursor;
    const key = cursor && JSON.stringify(cursor);
    if (!cursor || !key || seen.has(key)) throw new Error(`Incomplete timeline for ${agentId}`);
    seen.add(key);
    page = await timeline.refetch({ direction: "before", cursor, projection: "canonical", limit: 200 });
    entries.unshift(...page.entries);
  }
  if (page.error) throw new Error(page.error);
  return entries.map(entry => ({ item: entry.item, timestamp: entry.timestamp }));
}

export { fullTimeline as agentHistory };

async function children(paseo: PaseoApi, parentId: string): Promise<PaseoAgent[]> {
  const result: PaseoAgent[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await paseo.agents.list({ filter: { labels: { [PARENT_AGENT_ID_LABEL]: parentId }, includeArchived: true }, page: { limit: 200, cursor } });
    result.push(...page.entries.map(entry => entry.agent));
    if (!page.pageInfo.hasMore) break;
    cursor = page.pageInfo.nextCursor ?? undefined;
    if (!cursor || seen.has(cursor)) throw new Error("Incomplete child agent directory");
    seen.add(cursor);
  } while (cursor);
  // Juke's own judges carry the parent label for notification suppression; they never report.
  return result.filter(agent => agent.labels?.[PARENT_AGENT_ID_LABEL] === parentId && !agent.labels?.[JukeJudgeLabel]);
}

async function mapLimited<T, R>(values: readonly T[], limit: number, map: (value: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (next < values.length) { const index = next++; results[index] = await map(values[index]!); }
  }));
  return results;
}

/** Child timelines are only re-read when the child has changed since the last assessment. */
export function createSubagentClassifier() {
  const cache = new Map<string, { updatedAt: string; sends: SubagentSend[] }>();
  return async (paseo: PaseoApi, parentId: string, parent: readonly TimelineEntry[]) => {
    const linked = await children(paseo, parentId);
    const sends = await mapLimited(linked, 8, async child => {
      const key = `${parentId}:${child.id}`;
      const cached = cache.get(key);
      if (cached && cached.updatedAt === child.updatedAt) return { id: child.id, title: child.title, createdAt: child.createdAt, sends: cached.sends };
      const found = promptSends(await fullTimeline(paseo, child.id), parentId);
      cache.set(key, { updatedAt: child.updatedAt, sends: found });
      return { id: child.id, title: child.title, createdAt: child.createdAt, sends: found };
    });
    return classifySubagentMessages(parent, sends);
  };
}
