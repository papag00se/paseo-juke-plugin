import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** A pending, sent, or withdrawn nudge, shown in the judged agent's timeline. */
export const nudgeRowSchema = z.object({
  state: z.enum(["pending", "sent", "canceled", "superseded", "paused"]),
  /** Epoch milliseconds when a pending nudge is sent. */
  deadline: z.number(),
  pattern: z.string(),
  followUp: z.string(),
});
export type NudgeRow = z.output<typeof nudgeRowSchema>;

/** A pause or resume notice for one agent. */
export const pauseRowSchema = z.object({
  paused: z.boolean(),
  /** Minutes after the user's latest message that the pause lifts itself, or null if it never does. */
  autoResumeMinutes: z.number().nullable(),
});
export type PauseRow = z.output<typeof pauseRowSchema>;

const agentInput = z.object({ agentId: z.string().min(1) });
export const cancelNudge = defineRpc({ name: "juke.nudge.cancel", input: agentInput, output: z.object({ canceled: z.boolean() }) });
export const sendNudgeNow = defineRpc({ name: "juke.nudge.now", input: agentInput, output: z.object({ sent: z.boolean() }) });
export const pauseAgent = defineRpc({ name: "juke.pause", input: agentInput, output: z.object({}) });
export const resumeAgent = defineRpc({ name: "juke.resume", input: agentInput, output: z.object({ wasPaused: z.boolean() }) });
