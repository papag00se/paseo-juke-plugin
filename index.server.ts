import type { PluginServerContext, PluginHookContext, PluginLifecycleEvents } from "@getpaseo/plugin/server";
import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";
import { randomUUID } from "node:crypto";
import { childEvidence, idleDelegation, parentTimeline } from "./server/delegation";
import { isRoleOrchestrated } from "./server/ownership";
import { configuredJudge, enabledJukes, preferences, type JudgeChoice } from "./shared/settings";
import { JukeIds, type JukeId } from "./shared/jukes";
import { cancelNudge, pauseAgent, resumeAgent, sendNudgeNow, type NudgeRow, type PauseRow } from "./shared/nudge";
import { NudgeQueue, PauseBook } from "./server/nudges";
import {
  isJukeFollowUp,
  JukeFollowUpPrefix,
  judgeLabels,
  judgePrompt,
  parseVerdict,
  permitsJudgeSelection,
  VerdictRetryPrompt,
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
const nudgeRowId = (agentId: string) => `nudge:${agentId}`;
const pauseRowId = (agentId: string) => `pause:${agentId}`;

export function originalAutomaticContribution(server: PluginServerContext, readSettings = async (): Promise<JukeSettings> => DefaultSettings) {
  const ownJudgeIds = new Set<string>();
  const generationByAgentId = new Map<string, number>();
  const delegationVersion = new Map<string, number>();
  const pendingParents = new Map<string, { event: PluginLifecycleEvents["agent.turn_ended"]; context: PluginHookContext }>();
  const activeParents = new Set<string>();
  const seenChildTurns = new Set<string>();
  let stopped = false;
  const nudges = new NudgeQueue({ log: (message, detail) => console.error(message, detail) });
  const pauses = new PauseBook();
  const appendRow = (paseo: PluginHookContext["paseo"], agentId: string, row: { id: string; kind: "nudge"; data: NudgeRow } | { id: string; kind: "pause"; data: PauseRow }) =>
    paseo.agents.ref(agentId).timeline.append({ type: "plugin", id: row.id, kind: row.kind, version: 1, data: row.data })
      .then(() => undefined, error => console.error("[juke] failed to show timeline row", { agentId, error }));
  const pausedNow = async (paseo: PluginHookContext["paseo"], agentId: string, settings: JukeSettings) => {
    const snapshot = await paseo.agents.ref(agentId).refresh();
    return pauses.isPaused(agentId, snapshot?.agent?.lastUserMessageAt, settings.autoResume);
  };

  server.handle(cancelNudge, async ({ agentId }) => ({ canceled: await nudges.withdraw(agentId, "canceled") }));
  server.handle(sendNudgeNow, async ({ agentId }) => ({ sent: await nudges.sendNow(agentId) }));
  server.handle(pauseAgent, async ({ agentId }, { paseo }) => {
    pauses.pause(agentId);
    await nudges.withdraw(agentId, "paused");
    const settings = await readSettings();
    await appendRow(paseo, agentId, { id: pauseRowId(agentId), kind: "pause", data: { paused: true, autoResumeMinutes: settings.autoResume.enabled ? settings.autoResume.minutes : null } });
    return {};
  });
  server.handle(resumeAgent, async ({ agentId }, { paseo }) => {
    const wasPaused = pauses.resume(agentId);
    await appendRow(paseo, agentId, { id: pauseRowId(agentId), kind: "pause", data: { paused: false, autoResumeMinutes: null } });
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
    advance(agent.id);
    // The agent is working again (usually because the user wrote), so a waiting nudge is moot.
    void nudges.withdraw(agent.id, "superseded");
    if (agent.parentAgentId) {
      changeDelegation(agent.parentAgentId);
      // A grandchild resuming also invalidates an assessment of any idle ancestor.
      void (async () => {
        let id: string | null = agent.parentAgentId;
        const seen = new Set<string>();
        while (id && !seen.has(id)) {
          seen.add(id);
          const snapshot = await paseo.agents.ref(id).refresh();
          id = getParentAgentIdFromLabels(snapshot?.agent?.labels) ?? null;
          if (id && !seen.has(id)) changeDelegation(id);
        }
      })().catch(error => console.error("[juke] failed to inspect delegation ancestry", error));
    }
  });

  const assess = (event: PluginLifecycleEvents["agent.turn_ended"], { paseo }: PluginHookContext, delegation?: { evidence: string; stillCurrent: () => Promise<boolean> }) => {
    const generation = advance(event.agent.id);
    // Inference can outlive the lifecycle hook deadline, so keep it detached after recording
    // the current generation. The generation check is staleness protection, not a judgement.
    void (async () => {
      let judgeId: string | undefined;
      let reservedJudgeId: string | undefined;
      try {
        const preferences = await readSettings();
        if (!preferences.enabled || !preferences.jukes.length || stopped || !event.agent.workspaceId || (delegation && !preferences.jukes.includes("abandoned-after-delegation"))) return;
        const current = async () => {
          const next = await readSettings();
          return !stopped && next.enabled && next.revision === preferences.revision && generationByAgentId.get(event.agent.id) === generation && (!delegation || await delegation.stillCurrent());
        };
        const snapshot = await paseo.agents.ref(event.agent.id).refresh();
        if (await isRoleOrchestrated(paseo, snapshot?.agent)) return;
        if (pauses.isPaused(event.agent.id, snapshot?.agent?.lastUserMessageAt, preferences.autoResume)) {
          console.log("[juke] assessment skipped: paused with /juke-pause", { agentId: event.agent.id });
          return;
        }
        // Without a configured judge, reuse the judged agent. The SDK needs a "provider/model"
        // selection and the hook payload carries only the bare provider, so resolve its live model.
        const model = preferences.judge?.model ?? snapshot?.agent?.runtimeInfo?.model ?? snapshot?.agent?.model;
        if (!model) {
          console.error("[juke] no model resolved for judge", { agentId: event.agent.id });
          return;
        }
        const selection = `${preferences.judge?.provider ?? event.agent.provider}/${model}`;
        // Operator policy: a judge must not bill OpenRouter prepaid credit.
        if (!permitsJudgeSelection(selection, model)) {
          console.error("[juke] paid OpenRouter judge refused");
          return;
        }
        if (!(await current())) return;
        // Hook payloads can contain only a tail after a daemon/session reload. Fetch the
        // complete canonical history so earlier user direction is never silently dropped.
        const timeline = delegation ? event.timeline : await parentTimeline(paseo, event.agent.id);
        if (!(await current())) return;
        reservedJudgeId = randomUUID();
        ownJudgeIds.add(reservedJudgeId);
        const judge = await paseo.workspaces.ref(event.agent.workspaceId).agents.create({
          agentId: reservedJudgeId,
          title: "Juke inference judge",
          prompt: judgePrompt(timeline, delegation ? ["abandoned-after-delegation"] : preferences.jukes, preferences.prompt, delegation?.evidence, preferences.jukes),
          labels: judgeLabels(event.agent.id),
          config: {
            provider: selection,
            ...(preferences.judge?.thinkingOptionId ? { thinkingOptionId: preferences.judge.thinkingOptionId } : {}),
            systemPrompt: "You are a read-only semantic evaluator. Follow the prompt exactly and emit only its requested JSON.",
          },
        });
        judgeId = judge.id;
        ownJudgeIds.add(judge.id);
        if (!(await current())) return;

        const result = await judge.waitForFinish();
        if (!(await current())) return;
        if (result.status !== "idle" || !result.lastMessage) {
          console.error("[juke] inference judge did not complete", { agentId: event.agent.id, error: result.error });
          return;
        }

        let verdict = parseVerdict(result.lastMessage);
        if (!verdict) {
          // One corrective round-trip. A judge that answers in prose is recoverable; a judge
          // that cannot answer in JSON twice is a real defect and must be visible, not silent.
          console.error("[juke] verdict unparseable, retrying", {
            agentId: event.agent.id,
            raw: result.lastMessage.slice(0, 400),
          });
          await judge.send(VerdictRetryPrompt);
          const retry = await judge.waitForFinish();
          if (!(await current())) return;
          verdict = retry.status === "idle" && retry.lastMessage ? parseVerdict(retry.lastMessage) : null;
          if (!verdict) {
            console.error("[juke] verdict unparseable after retry; skipping this turn", {
              agentId: event.agent.id,
              raw: (retry.lastMessage ?? retry.error ?? "").slice(0, 400),
            });
            return;
          }
        }
        console.log("[juke] assessment completed", {
          agentId: event.agent.id,
          judgeId,
          turnId: event.turnId,
          decision: verdict.decision,
          pattern: verdict.pattern,
          rationale: verdict.rationale,
        });
        if (verdict.decision !== "continue" || !verdict.followUp || !(await current())) return;
        // The judge is told which jukes are off; this enforces the user's choice if it strays.
        if (!preferences.jukes.includes(verdict.pattern) || (delegation && verdict.pattern !== "abandoned-after-delegation")) {
          console.log("[juke] continuation skipped: juke turned off", { agentId: event.agent.id, pattern: verdict.pattern });
          return;
        }
        const agentId = event.agent.id;
        const followUp = verdict.followUp;
        await nudges.enqueue({
          agentId,
          pattern: verdict.pattern,
          followUp,
          delayMs: preferences.nudgeDelaySeconds * 1000,
          publish: row => appendRow(paseo, agentId, { id: nudgeRowId(agentId), kind: "nudge", data: row }),
          stillCurrent: async () => (await current()) && !(await pausedNow(paseo, agentId, preferences)),
          deliver: () => paseo.agents.ref(agentId).send(
            `${JukeFollowUpPrefix} ${followUp}\n\nCarry this out now. Do not stop at a plan or promise; if you are truly blocked, ask the user one specific question.`,
          ).then(() => undefined),
        });
      } catch (error) {
        console.error("[juke] inference judge failed", { agentId: event.agent.id, error });
      } finally {
        if (judgeId) {
          await paseo.agents.ref(judgeId).archive().catch(() => undefined);
          ownJudgeIds.delete(judgeId);
        }
        if (reservedJudgeId) ownJudgeIds.delete(reservedJudgeId);
      }
    })();
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
          if (!preferences.enabled || !preferences.jukes.includes("abandoned-after-delegation")) continue;
          const tree = await idleDelegation(pending.context.paseo, parentId);
          if (!tree || await isRoleOrchestrated(pending.context.paseo, tree.parent)) continue;
          const timeline = await parentTimeline(pending.context.paseo, parentId);
          const evidence = await childEvidence(pending.context.paseo, tree.children, pending.event.agent.id);
          const stillCurrent = async () => {
            if (delegationVersion.get(parentId) !== version) return false;
            const latest = await idleDelegation(pending.context.paseo, parentId);
            return !!latest && latest.children.length === tree.children.length && latest.children.every(child => tree.children.some(old => old.id === child.id));
          };
          if (!(await stillCurrent())) continue;
          assess({ agent: { id: parentId, parentAgentId: null, workspaceId: tree.parent.workspaceId ?? null, provider: tree.parent.provider, cwd: tree.parent.cwd, title: tree.parent.title }, turnId: null, outcome: { kind: "completed" }, timeline }, pending.context, { evidence, stillCurrent });
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
            if (id && !seen.has(id)) reviewParent(event, context, id);
          }
        })().catch(error => console.error("[juke] failed to inspect delegation ancestry", error));
      }
    }
    if (event.outcome.kind !== "completed" || isJukeFollowUp(event.timeline)) return;
    assess(event, context);
  });

  return () => {
    stopped = true;
    void nudges.clear();
    removeStarted();
    removeEnded();
  };
}
