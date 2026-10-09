import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

// An empty judge provider means "judge with the same provider and model as the agent being judged".
export const preferences = defineSettings({
  id: "juke", scope: "host", version: 1,
  schema: z.object({
    enabled: z.boolean().default(true),
    judgeProvider: z.string().default(""),
    judgeModel: z.string().default(""),
    judgeThinkingOptionId: z.string().nullable().default(null),
  }),
});

export type JudgeChoice = { provider: string; model: string; thinkingOptionId: string | null };

/** The configured judge, or null when Juke should reuse the judged agent's provider and model. */
export function configuredJudge(values: { judgeProvider: string; judgeModel: string; judgeThinkingOptionId: string | null }): JudgeChoice | null {
  return values.judgeProvider && values.judgeModel
    ? { provider: values.judgeProvider, model: values.judgeModel, thinkingOptionId: values.judgeThinkingOptionId }
    : null;
}
