import type { PluginServerContext } from "@getpaseo/plugin/server";
import { isRoleOrchestrated } from "./server/ownership";
import { configuredJudge, preferences, type JudgeChoice } from "./shared/settings";
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
    return { enabled: state.values.enabled, judge: configuredJudge(state.values), revision: `${epoch}:${state.revision}` };
  });
  return () => { unsubscribe(); stop(); };
}

type JukeSettings = { enabled: boolean; judge?: JudgeChoice | null; revision: string };

export function originalAutomaticContribution(server: PluginServerContext, readSettings = async (): Promise<JukeSettings> => ({ enabled: true, revision: "default" })) {
  const ownJudgeIds = new Set<string>();
  const generationByAgentId = new Map<string, number>();
  let stopped = false;

  const advance = (agentId: string) => {
    const next = (generationByAgentId.get(agentId) ?? 0) + 1;
    generationByAgentId.set(agentId, next);
    return next;
  };

  const removeStarted = server.on("agent.turn_started", ({ agent }) => {
    if (!ownJudgeIds.has(agent.id)) advance(agent.id);
  });

  const removeEnded = server.on("agent.turn_ended", (event, { paseo }) => {
    if (event.outcome.kind !== "completed" || ownJudgeIds.has(event.agent.id) || isJukeFollowUp(event.timeline)) return;

    const generation = advance(event.agent.id);
    // Inference can outlive the lifecycle hook deadline, so keep it detached after recording
    // the current generation. The generation check is staleness protection, not a judgement.
    void (async () => {
      let judgeId: string | undefined;
      try {
        const preferences = await readSettings();
        if (!preferences.enabled || stopped || !event.agent.workspaceId) return;
        const current = async () => {
          const next = await readSettings();
          return !stopped && next.enabled && next.revision === preferences.revision && generationByAgentId.get(event.agent.id) === generation;
        };
        const snapshot = await paseo.agents.ref(event.agent.id).refresh();
        if (await isRoleOrchestrated(paseo, snapshot?.agent)) return;
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
        const judge = await paseo.workspaces.ref(event.agent.workspaceId).agents.create({
          title: "Juke inference judge",
          prompt: judgePrompt(event.timeline),
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
        await paseo.agents.ref(event.agent.id).send(
          `${JukeFollowUpPrefix} ${verdict.followUp}\n\nCarry this out now. Do not stop at a plan or promise; if you are truly blocked, ask the user one specific question.`,
        );
      } catch (error) {
        console.error("[juke] inference judge failed", { agentId: event.agent.id, error });
      } finally {
        if (judgeId) {
          await paseo.agents.ref(judgeId).archive().catch(() => undefined);
          ownJudgeIds.delete(judgeId);
        }
      }
    })();
  });

  return () => {
    stopped = true;
    removeStarted();
    removeEnded();
  };
}
