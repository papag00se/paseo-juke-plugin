import type { PluginServerContext, PluginHookContext, PluginLifecycleEvents } from "@getpaseo/plugin/server";
import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { randomUUID } from "node:crypto";
import { childEvidence, descendantSnapshot, idleDelegation, parentTimeline } from "./server/delegation";
import { backgroundEvidence } from "./server/background";
import { JudgeSessions, mergeLedger, RecentItemsOnRestart, RotateAfterChars } from "./server/judge-sessions";
import { profileFor, type ResolvedProfile } from "./server/profiles";
import { awaitFinishNotification, type FinishNotificationTiming } from "./server/finish-notifications";
import { isRoleOrchestrated, isRoleOrchestratorHelper } from "./server/ownership";
import { configuredJudge, enabledJukes, preferences, type JudgeChoice } from "./shared/settings";
import { JukeIds, type JukeId } from "./shared/jukes";
import { cancelNudge, pauseAgent, resumeAgent, sendNudgeNow, type NudgeRow, type PauseRow } from "./shared/nudge";
import { NudgeQueue, PauseBook } from "./server/nudges";
import {
  consecutiveFollowUps,
  initialJudgeMessage,
  MaxConsecutiveFollowUps,
  UnconfirmedFollowUp,
  JukeFollowUpPrefix,
  judgeInstructions,
  judgeLabels,
  nextJudgeMessage,
  parseVerdict,
  permitsJudgeSelection,
  UnfinishedAsk,
  VerdictRetryPrompt,
  type Ask,
  type JudgeProfile,
  type Verdict,
} from "./server/judge";

export default function contribute(server: PluginServerContext) {
  // Jesse explicitly authorized Juke's judge agents on 2026-10-02.
  const settings = server.registerSettings(preferences);
  // Paseo revisions are content hashes: disabling and re-enabling can restore
  // the same revision. An epoch also invalidates assessments across that cycle.
  let settingsEpoch = 0;
  const unsubscribe = settings.subscribe(() => { settingsEpoch++; });
  const stop = originalAutomaticContribution(server, async () => {
    const epoch = settingsEpoch;
    const state = await settings.read();
    if (state.status !== "ready") throw new Error(`Juke settings unavailable: ${state.error}`);
    const values = state.values;
    return {
      enabled: values.enabled, jukes: enabledJukes(values), prompt: values.judgePrompt, judge: configuredJudge(values), revision: `${epoch}:${state.revision}`,
      nudgeDelaySeconds: values.nudgeDelaySeconds, autoResume: { enabled: values.pauseAutoResume, minutes: values.pauseAutoResumeMinutes },
    };
  });
  return () => { unsubscribe(); stop(); };
}

type JukeSettings = {
  enabled: boolean; jukes: readonly JukeId[]; prompt?: string; judge?: JudgeChoice | null; revision: string;
  nudgeDelaySeconds: number; autoResume: { enabled: boolean; minutes: number };
};

const DefaultSettings: JukeSettings = { enabled: true, jukes: JukeIds, revision: "default", nudgeDelaySeconds: 15, autoResume: { enabled: true, minutes: 5 } };

/** Stable row ids: each agent has one live nudge row and one pause row, replaced in place. */
// The app updates a plugin row in place when its id repeats, so each nudge and pause notice needs
// its own id; reusing one per agent rewrote the old row far up the history instead of showing a new one.
const newRowId = (kind: "nudge" | "pause", agentId: string) => `${kind}:${agentId}:${randomUUID()}`;

export function originalAutomaticContribution(
  server: PluginServerContext,
  readSettings = async (): Promise<JukeSettings> => DefaultSettings,
  options: { notificationTiming?: Partial<FinishNotificationTiming> } = {},
) {
  const ownJudgeIds = new Set<string>();
  const generationByAgentId = new Map<string, number>();
  const delegationVersion = new Map<string, number>();
  const pendingParents = new Map<string, { event: PluginLifecycleEvents["agent.turn_ended"]; context: PluginHookContext }>();
  const activeParents = new Set<string>();
  const seenChildTurns = new Set<string>();
  let stopped = false;
  const sessions = new JudgeSessions();
  // Persistent judges outlive a reload; their own turns must never be judged.
  void sessions.load().then(() => { for (const id of sessions.judgeIds()) ownJudgeIds.add(id); });
  const nudges = new NudgeQueue({ log: (message, detail) => console.error(message, detail) });
  const pauses = new PauseBook();
  const appendRow = (paseo: PluginHookContext["paseo"], agentId: string, row: { id: string; kind: "nudge"; data: NudgeRow } | { id: string; kind: "pause"; data: PauseRow }) =>
    paseo.agents.ref(agentId).timeline.append({ type: "plugin", id: row.id, kind: row.kind, version: 1, data: row.data })
      .then(() => undefined, error => console.error("[juke] failed to show timeline row", { agentId, error }));

  server.handle(cancelNudge, async ({ agentId }) => ({ canceled: await nudges.withdraw(agentId, "canceled") }));
  server.handle(sendNudgeNow, async ({ agentId }) => ({ sent: await nudges.sendNow(agentId) }));
  server.handle(pauseAgent, async ({ agentId }, { paseo }) => {
    pauses.pause(agentId);
    await nudges.withdraw(agentId, "paused");
    const settings = await readSettings();
    await appendRow(paseo, agentId, { id: newRowId("pause", agentId), kind: "pause", data: { paused: true, autoResumeMinutes: settings.autoResume.enabled ? settings.autoResume.minutes : null } });
    return {};
  });
  server.handle(resumeAgent, async ({ agentId }, { paseo }) => {
    const wasPaused = pauses.resume(agentId);
    await appendRow(paseo, agentId, { id: newRowId("pause", agentId), kind: "pause", data: { paused: false, autoResumeMinutes: null } });
    return { wasPaused };
  });
  const changeDelegation = (parentId: string) => delegationVersion.set(parentId, (delegationVersion.get(parentId) ?? 0) + 1);

  const advance = (agentId: string) => {
    const next = (generationByAgentId.get(agentId) ?? 0) + 1;
    generationByAgentId.set(agentId, next);
    return next;
  };

  const removeStarted = server.on("agent.turn_started", ({ agent }, { paseo }) => {
    if (ownJudgeIds.has(agent.id)) return;
    const startedAt = Date.now();
    void readSettings().then(settings => pauses.noteTurnStart(agent.id, settings.autoResume, startedAt), error => console.error("[juke] could not update pause activity", { agentId: agent.id, error }));
    advance(agent.id);
    // The agent is working again (usually because the user wrote), so a waiting nudge is moot.
    void nudges.withdraw(agent.id, "superseded");
    if (agent.parentAgentId) {
      changeDelegation(agent.parentAgentId);
      // A grandchild resuming also invalidates an assessment of any idle ancestor.
      // Work anywhere below an agent is activity for its pause, too.
      void (async () => {
        const { autoResume } = await readSettings();
        let id: string | null = agent.parentAgentId;
        const seen = new Set<string>();
        while (id) {
          if (seen.has(id)) break;
          seen.add(id);
          pauses.noteTurnStart(id, autoResume, startedAt);
          const snapshot = await paseo.agents.ref(id).refresh();
          id = getParentAgentIdFromLabels(snapshot?.agent?.labels) ?? null;
          if (id && !seen.has(id)) changeDelegation(id);
        }
      })().catch(error => console.error("[juke] failed to inspect delegation ancestry", error));
    }
  });

  // Only the fields assessment reads, so a delegation review can stand in for a turn-ended event.
  type AssessedTurn = { agent: Pick<PluginLifecycleEvents["agent.turn_ended"]["agent"], "id" | "workspaceId" | "provider">; turnId: string | null };
  type DelegationReview = { evidence: string; stillCurrent: () => Promise<boolean>; timeline: AgentTimelineItem[]; resolved: ResolvedProfile | null };
  const assess = (event: AssessedTurn, { paseo }: PluginHookContext, delegation?: DelegationReview) => {
    const generation = advance(event.agent.id);
    const endedAt = Date.now();
    // Inference can outlive the lifecycle hook deadline, so keep it detached after recording
    // the current generation. The generation check is staleness protection, not a judgement.
    void (async () => {
      const agentId = event.agent.id;
      try {
        const preferences = await readSettings();
        if (!preferences.enabled || stopped || !event.agent.workspaceId) return;
        const snapshot = await paseo.agents.ref(agentId).refresh();
        if (isRoleOrchestratorHelper(snapshot?.agent?.labels)) return;
        const resolved = delegation ? delegation.resolved : await profileFor(snapshot?.agent?.labels);
        const profile: JudgeProfile = resolved?.profile ?? "default";
        const strict = profile === "strict";
        if (!strict) {
          if (!preferences.jukes.length || (delegation && !preferences.jukes.includes("abandoned-after-delegation"))) return;
          // Role Orchestrator owns its runs; only its strict-profile agents are judged here.
          if (await isRoleOrchestrated(paseo, snapshot?.agent)) return;
        }
        const current = async () => {
          const next = await readSettings();
          return !stopped && next.enabled && next.revision === preferences.revision && generationByAgentId.get(agentId) === generation && (!delegation || await delegation.stillCurrent());
        };
        if (pauses.isPaused(agentId, preferences.autoResume)) {
          console.log("[juke] assessment skipped: paused with /juke-pause", { agentId });
          return;
        }
        // Without a configured judge, reuse the judged agent. The SDK needs a "provider/model"
        // selection and the hook payload carries only the bare provider, so resolve its live model.
        // A strict agent's owning plugin chooses its judge; otherwise Juke's setting. Either way the
        // default is the judged agent's own model.
        const choice = strict ? resolved?.judge ?? null : preferences.judge;
        const model = choice?.model ?? snapshot?.agent?.runtimeInfo?.model ?? snapshot?.agent?.model;
        if (!model) {
          console.error("[juke] no model resolved for judge", { agentId });
          return;
        }
        const selection = `${choice?.provider ?? event.agent.provider}/${model}`;
        // Operator policy: a judge must not bill OpenRouter prepaid credit.
        if (!permitsJudgeSelection(selection, model)) {
          console.error("[juke] paid OpenRouter judge refused");
          return;
        }
        if (!(await current())) return;
        // Hook payloads can contain only a tail after a daemon/session reload. Fetch the
        // complete canonical history so earlier user direction is never silently dropped.
        const timeline = delegation ? delegation.timeline : await parentTimeline(paseo, agentId);
        if (!(await current())) return;
        // The agent's reply to a nudge is judged like any turn, but Juke stops after a few nudges in a
        // row without a new message from the user, so it can never nag in a loop.
        if (consecutiveFollowUps(timeline) >= MaxConsecutiveFollowUps) {
          console.log("[juke] assessment skipped: follow-up limit reached", { agentId, limit: MaxConsecutiveFollowUps });
          return;
        }
        const checks = delegation && !strict ? ["abandoned-after-delegation" as const] : preferences.jukes;
        const instructions = judgeInstructions(checks, preferences.prompt, preferences.jukes, profile);
        const thinking = choice?.thinkingOptionId ?? null;
        const key = JSON.stringify([selection, thinking, instructions]);
        // Running subagents and background work are evidence of in-flight work. An unreadable source is
        // said so, never guessed.
        const descendants = await descendantSnapshot(paseo, agentId, ownJudgeIds).catch((error) => {
          console.error("[juke] descendant snapshot unavailable", { agentId, error });
          return null;
        });
        const background = await backgroundEvidence([agentId, ...(descendants ?? []).map((agent) => agent.id)], endedAt);
        const liveContext = [
          descendants ? `Live descendant snapshot (status and permission counts, not proof of task coverage): ${JSON.stringify(descendants)}` : "Live descendant snapshot: unavailable.",
          ...(background ? [background] : []),
        ].join("\n\n");

        await sessions.load();
        const outcome = await sessions.exclusive(agentId, async () => {
          // A newer turn queued behind this one will judge everything this one would have.
          if (!(await current())) return null;
          let session = sessions.get(agentId);
          let judgeId: string | null = null;
          let sent = 0;
          let result: Awaited<ReturnType<ReturnType<typeof paseo.agents.ref>["run"]>> | null = null;
          if (session.judgeId && session.key === key && session.judgedItems <= timeline.length && session.sentChars < RotateAfterChars) {
            const message = nextJudgeMessage(timeline.slice(session.judgedItems), session.ledger, delegation?.evidence, liveContext);
            ownJudgeIds.add(session.judgeId);
            try {
              // Prompting the archived judge unarchives it; its saved conversation is the cached prefix.
              const reply = await paseo.agents.ref(session.judgeId).run(message);
              if (reply.status === "idle" && reply.lastMessage) { result = reply; judgeId = session.judgeId; sent = message.length; }
              else console.error("[juke] judge session did not answer; starting a new one", { agentId, judgeId: session.judgeId, error: reply.error });
            } catch (error) {
              console.error("[juke] judge session unavailable; starting a new one", { agentId, judgeId: session.judgeId, error });
            }
          }
          if (!result) {
            // A replacement judge session (rotation, a model or instruction change, a lost judge) starts
            // from the ask ledger and the recent conversation; only an agent's first judge reads it all.
            const seeded = session.judgedItems > 0 && session.ledger.length > 0;
            const recent = seeded ? timeline.slice(-RecentItemsOnRestart) : timeline;
            const message = initialJudgeMessage(instructions, recent, session.ledger, delegation?.evidence, liveContext, seeded ? timeline.length - recent.length : 0);
            const reserved = randomUUID();
            ownJudgeIds.add(reserved);
            const judge = await paseo.workspaces.ref(event.agent.workspaceId!).agents.create({
              agentId: reserved,
              title: "Juke inference judge",
              prompt: message,
              labels: judgeLabels(agentId),
              config: {
                provider: selection,
                ...(thinking ? { thinkingOptionId: thinking } : {}),
                systemPrompt: "You are a read-only semantic evaluator. Follow the prompt exactly and emit only its requested JSON.",
              },
            });
            ownJudgeIds.add(judge.id);
            judgeId = judge.id;
            session = { ...session, judgeId, key, sentChars: 0 };
            sent = message.length;
            result = await judge.waitForFinish();
          }
          const judge = paseo.agents.ref(judgeId!);
          try {
            if (result.status !== "idle" || !result.lastMessage) {
              console.error("[juke] inference judge did not complete", { agentId, error: result.error });
              return null;
            }
            let verdict: Verdict | null = parseVerdict(result.lastMessage);
            if (!verdict) {
              // One corrective round-trip. A judge that answers in prose is recoverable; a judge
              // that cannot answer in JSON twice is a real defect and must be visible, not silent.
              console.error("[juke] verdict unparseable, retrying", { agentId, raw: result.lastMessage.slice(0, 400) });
              const retry = await judge.run(VerdictRetryPrompt);
              sent += VerdictRetryPrompt.length;
              verdict = retry.status === "idle" && retry.lastMessage ? parseVerdict(retry.lastMessage) : null;
              if (!verdict) console.error("[juke] verdict unparseable after retry", { agentId, raw: (retry.lastMessage ?? retry.error ?? "").slice(0, 400) });
            }
            const ledger = mergeLedger(session.ledger, verdict?.asks);
            // Recorded in memory at once (the next queued assessment reads it); saved to disk in the background.
            void sessions.put(agentId, { ...session, judgeId, key, judgedItems: timeline.length, sentChars: session.sentChars + sent, ledger });
            return { verdict, ledger, judgeId: judgeId! };
          } finally {
            // Archive between turns; the next prompt unarchives it with its saved conversation.
            await judge.archive().catch(() => undefined);
          }
        });
        if (!outcome) return;
        const { verdict, ledger, judgeId } = outcome;
        const open = ledger.filter((ask) => ask.status === "open");
        if (!verdict) {
          // Fail closed: an undecidable verdict never passes as completion. Asking the agent to account
          // for each ask also puts them in the conversation for the next judgement.
          if (!(await current())) return;
          await deliverNudge(paseo, agentId, strict ? UnfinishedAsk : "claimed-done-but-not", UnconfirmedFollowUp, open, preferences.nudgeDelaySeconds * 1000, preferences, current);
          return;
        }
        console.log("[juke] assessment completed", {
          agentId,
          judgeId,
          turnId: event.turnId,
          profile,
          decision: verdict.decision,
          pattern: verdict.pattern,
          rationale: verdict.rationale,
          openAsks: open.length,
        });
        if (verdict.decision !== "continue" || !verdict.followUp || !(await current())) return;
        // The judge is told which jukes are off; this enforces the user's choice if it strays.
        const allowed = strict ? [...preferences.jukes, UnfinishedAsk] : delegation ? ["abandoned-after-delegation"] : preferences.jukes;
        if (!(allowed as readonly string[]).includes(verdict.pattern)) {
          console.log("[juke] continuation skipped: juke turned off", { agentId, pattern: verdict.pattern });
          return;
        }
        await deliverNudge(paseo, agentId, verdict.pattern, verdict.followUp, open, preferences.nudgeDelaySeconds * 1000, preferences, current);
      } catch (error) {
        console.error("[juke] inference judge failed", { agentId, error });
      }
    })();
  };

  /** The nudge restates the open asks, so an agent whose context was compacted gets them back. */
  const deliverNudge = async (paseo: PluginHookContext["paseo"], agentId: string, pattern: string, followUp: string, open: readonly Ask[], delayMs: number, preferences: JukeSettings, current: () => Promise<boolean> = async () => true) => {
    const reminder = open.length ? `\n\nOpen items from the user's requests:\n${open.slice(0, 20).map((ask) => `- ${ask.item}`).join("\n")}` : "";
    const rowId = newRowId("nudge", agentId);
    await nudges.enqueue({
      agentId,
      pattern,
      followUp,
      delayMs,
      publish: row => appendRow(paseo, agentId, { id: rowId, kind: "nudge", data: row }),
      stillCurrent: async () => (await current()) && !pauses.isPaused(agentId, preferences.autoResume),
      deliver: () => paseo.agents.ref(agentId).send(
        `${JukeFollowUpPrefix} ${followUp}${reminder}\n\nCarry this out now. Do not stop at a plan or promise; if you are truly blocked, ask the user one specific question.`,
      ).then(() => undefined),
    });
  };

  const reviewParent = (event: PluginLifecycleEvents["agent.turn_ended"], context: PluginHookContext, parentId = event.agent.parentAgentId) => {
    if (!parentId || ownJudgeIds.has(event.agent.id) || event.outcome.kind === "canceled") return;
    changeDelegation(parentId);
    pendingParents.set(parentId, { event, context });
    if (activeParents.has(parentId)) return;
    activeParents.add(parentId);
    void (async () => {
      try {
        while (!stopped && pendingParents.has(parentId)) {
          const pending = pendingParents.get(parentId)!;
          pendingParents.delete(parentId);
          const version = delegationVersion.get(parentId);
          const preferences = await readSettings();
          const parentSnapshot = await pending.context.paseo.agents.ref(parentId).refresh();
          const resolved = await profileFor(parentSnapshot?.agent?.labels);
          const strict = resolved?.profile === "strict";
          if (!preferences.enabled || (!strict && !preferences.jukes.includes("abandoned-after-delegation"))) continue;
          const tree = await idleDelegation(pending.context.paseo, parentId);
          if (!tree || (!strict && await isRoleOrchestrated(pending.context.paseo, tree.parent))) continue;
          // Paseo's own child-finished notification normally resumes an idle parent within seconds.
          // Judge only if it did not, so a judge is never spent on a parent about to resume itself.
          const parentGeneration = generationByAgentId.get(parentId) ?? 0;
          const proceed = await awaitFinishNotification({
            callerId: parentId,
            childIds: () => tree.children.map(child => child.id),
            superseded: () => stopped || delegationVersion.get(parentId) !== version || (generationByAgentId.get(parentId) ?? 0) !== parentGeneration,
            timing: options.notificationTiming,
          });
          if (!proceed) continue;
          const timeline = await parentTimeline(pending.context.paseo, parentId);
          const evidence = await childEvidence(pending.context.paseo, tree.children, pending.event.agent.id);
          const stillCurrent = async () => {
            if (delegationVersion.get(parentId) !== version) return false;
            const latest = await idleDelegation(pending.context.paseo, parentId);
            return !!latest && latest.children.length === tree.children.length && latest.children.every(child => tree.children.some(old => old.id === child.id));
          };
          if (!(await stillCurrent())) continue;
          assess({ agent: { id: parentId, workspaceId: tree.parent.workspaceId ?? null, provider: tree.parent.provider }, turnId: null }, pending.context, { evidence, stillCurrent, timeline, resolved });
        }
      } catch (error) {
        console.error("[juke] delegated-agent assessment failed", { parentId, error });
      } finally {
        activeParents.delete(parentId);
        const pending = pendingParents.get(parentId);
        if (pending && !stopped) reviewParent(pending.event, pending.context, parentId);
      }
    })();
  };

  const removeEnded = server.on("agent.turn_ended", (event, context) => {
    if (ownJudgeIds.has(event.agent.id)) return;
    // A turn ending anywhere below an agent is activity for its pause. Touch before any review runs.
    pauses.noteTurnEnd(event.agent.id);
    if (event.agent.parentAgentId) pauses.noteTurnEnd(event.agent.parentAgentId);
    const key = event.turnId && `${event.agent.id}:${event.turnId}`;
    if (!key || !seenChildTurns.has(key)) {
      if (event.agent.parentAgentId && key) {
        seenChildTurns.add(key);
        if (seenChildTurns.size > 4096) seenChildTurns.delete(seenChildTurns.values().next().value!);
      }
      reviewParent(event, context);
      if (event.agent.parentAgentId && event.outcome.kind !== "canceled") {
        void (async () => {
          let id: string | null = event.agent.parentAgentId;
          const seen = new Set<string>();
          while (id && !seen.has(id)) {
            seen.add(id);
            const snapshot = await context.paseo.agents.ref(id).refresh();
            id = getParentAgentIdFromLabels(snapshot?.agent?.labels) ?? null;
            if (id && !seen.has(id)) { pauses.noteTurnEnd(id); reviewParent(event, context, id); }
          }
        })().catch(error => console.error("[juke] failed to inspect delegation ancestry", error));
      }
    }
    if (event.outcome.kind !== "completed") return;
    assess(event, context);
  });

  return () => {
    stopped = true;
    void nudges.clear();
    removeStarted();
    removeEnded();
  };
}
