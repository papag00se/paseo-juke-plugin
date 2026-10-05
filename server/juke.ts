import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";

const GUARD_PREFIX = "[Juke guardrail]";

const WORK_REQUEST = /\b(?:add|build|change|check|create|debug|deploy|document|edit|fix|implement|improve|install|investigate|migrate|refactor|remove|rename|repair|run|test|update|upgrade|write)\b/i;
const DIRECTIVE = /^(?:please\s+)?(?:can|could|would|will)\s+you\b|^(?:please\s+)?(?:add|build|change|check|create|debug|deploy|document|edit|fix|implement|improve|install|investigate|migrate|refactor|remove|rename|repair|run|test|update|upgrade|write)\b/i;
const INFORMATION_REQUEST = /^(?:what|why|how|when|where|who)\b|\b(?:explain|describe|summari[sz]e|tell me|show me an example)\b/i;
const COMMITMENT = /\b(?:i(?:'m| am) going to|i(?:'ll| will)|let me|next,? i(?:'ll| will)|i plan to|i need to)\b/i;
const COMPLETION = /\b(?:done|completed|implemented|fixed|changed|updated|added|removed|created|ran|tested|verified|here(?:'s| is) (?:the|a)|the (?:answer|result|patch|diff) is)\b/i;

export interface JukeVerdict {
  prompt: string;
  output: string;
  reason: "empty-follow-through" | "unfulfilled-work-request";
}

/** Returns the latest user request and every item produced after it. */
function latestExchange(timeline: readonly AgentTimelineItem[]) {
  let userIndex = -1;
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    if (timeline[index].type === "user_message") {
      userIndex = index;
      break;
    }
  }
  if (userIndex < 0) return null;

  const user = timeline[userIndex];
  if (user.type !== "user_message") return null;
  return { prompt: user.text.trim(), response: timeline.slice(userIndex + 1) };
}

function assistantText(items: readonly AgentTimelineItem[]): string {
  return items
    .filter((item): item is Extract<AgentTimelineItem, { type: "assistant_message" }> => item.type === "assistant_message")
    .map((item) => item.text)
    .join("\n")
    .trim();
}

/**
 * Conservatively identify a task request. Questions that merely seek an explanation do not count,
 * while requests to inspect, change, test, or create something do.
 */
function likelyWorkRequest(prompt: string): boolean {
  if (!WORK_REQUEST.test(prompt)) return false;
  if (INFORMATION_REQUEST.test(prompt) && !DIRECTIVE.test(prompt)) return false;
  return DIRECTIVE.test(prompt) || /\b(?:please|need|want|should)\b/i.test(prompt) || WORK_REQUEST.test(prompt);
}

/**
 * Detect a completed turn that announced future work but never used a tool. This is intentionally
 * narrow: a text-only answer can still be a legitimate answer, so Juke only interrupts clear
 * promises or a very short non-answer to an explicit work request.
 */
export function inspectTurn(timeline: readonly AgentTimelineItem[]): JukeVerdict | null {
  const exchange = latestExchange(timeline);
  if (!exchange || !exchange.prompt || exchange.prompt.startsWith(GUARD_PREFIX)) return null;
  if (!likelyWorkRequest(exchange.prompt)) return null;

  const output = assistantText(exchange.response);
  const usedTool = exchange.response.some((item) => item.type === "tool_call");
  if (usedTool || COMPLETION.test(output)) return null;

  if (COMMITMENT.test(output)) {
    return { prompt: exchange.prompt, output, reason: "empty-follow-through" };
  }

  // An explicit imperative followed by a terse, non-delivering reply is also a missed action.
  if (DIRECTIVE.test(exchange.prompt) && output.length > 0 && output.length < 180) {
    return { prompt: exchange.prompt, output, reason: "unfulfilled-work-request" };
  }

  return null;
}

export function continuation(verdict: JukeVerdict): string {
  return `${GUARD_PREFIX} The prior user message appears to request actual work, but the completed turn ${
    verdict.reason === "empty-follow-through" ? "only announced future work" : "did not show that work being done"
  }. Re-read the user's request and carry it out now. Use the available tools when useful; do not end this turn with another promise or plan. If progress genuinely requires user input, ask one specific blocking question instead.`;
}
