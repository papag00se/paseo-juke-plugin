import type { PluginServerContext } from "@getpaseo/plugin/server";
import { isRoleOrchestrated } from "./server/ownership";
import {
  isJukeFollowUp,
  JukeFollowUpPrefix,
  judgeLabels,
  judgePrompt,
  parseVerdict,
  VerdictRetryPrompt,
} from "./server/judge";

export default function contribute(server: PluginServerContext) {
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
        if (!event.agent.workspaceId) return;
        // The SDK needs a "provider/model" selection; the hook payload carries only the
        // bare provider, so resolve the judged agent's live model and reuse it.
        const snapshot = await paseo.agents.ref(event.agent.id).refresh();
        if (await isRoleOrchestrated(paseo, snapshot?.agent)) return;
        const model = snapshot?.agent?.runtimeInfo?.model ?? snapshot?.agent?.model;
        if (!model) {
          console.error("[juke] no model resolved for judge", { agentId: event.agent.id });
          return;
        }
        const judge = await paseo.workspaces.ref(event.agent.workspaceId).agents.create({
          title: "Juke inference judge",
          prompt: judgePrompt(event.timeline),
          labels: judgeLabels(event.agent.id),
          config: {
            provider: `${event.agent.provider}/${model}`,
            systemPrompt: "You are a read-only semantic evaluator. Follow the prompt exactly and emit only its requested JSON.",
          },
        });
        judgeId = judge.id;
        ownJudgeIds.add(judge.id);

        const result = await judge.waitForFinish();
        if (stopped || generationByAgentId.get(event.agent.id) !== generation) return;
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
          if (stopped || generationByAgentId.get(event.agent.id) !== generation) return;
          verdict = retry.status === "idle" && retry.lastMessage ? parseVerdict(retry.lastMessage) : null;
          if (!verdict) {
            console.error("[juke] verdict unparseable after retry; skipping this turn", {
              agentId: event.agent.id,
              raw: (retry.lastMessage ?? retry.error ?? "").slice(0, 400),
            });
            return;
          }
        }
        if (verdict.decision !== "continue" || !verdict.followUp) return;

        console.log("[juke] inference requested continuation", {
          agentId: event.agent.id,
          pattern: verdict.pattern,
          rationale: verdict.rationale,
        });
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
