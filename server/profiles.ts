import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { JudgeProfile } from "./judge";
import type { JudgeChoice } from "../shared/settings";

/** An agent can ask for a profile directly with this label. */
export const JukeProfileLabel = "juke.profile";

/**
 * Other plugins choose Juke's profile for agents they own without relabelling them: they write
 * `plugin-data/juke-profiles.json` as `{ "labels": { "<label key>": { "<label value>": <entry> } } }`, where an entry is
 * "strict" or `{ "profile": "strict", "judge": { "provider", "model", "thinkingOptionId" } }`. The judge is the owning
 * plugin's own setting; without one, the agent's own model judges, as for any other agent.
 * Role Orchestrator maps its gate-enabled roles to "strict" this way, which also covers agents that
 * existed before the role was gated.
 */
const profilesPath = () => join(process.env.PASEO_HOME || join(homedir(), ".paseo"), "plugin-data", "juke-profiles.json");

export interface ResolvedProfile { profile: JudgeProfile; judge: JudgeChoice | null }

/** An entry is "strict" or `{ "profile": "strict", "judge": { provider, model, thinkingOptionId } }`. */
function entry(value: unknown): ResolvedProfile | null {
  if (value === "strict") return { profile: "strict", judge: null };
  if (!value || typeof value !== "object") return null;
  const { profile, judge } = value as { profile?: unknown; judge?: { provider?: unknown; model?: unknown; thinkingOptionId?: unknown } };
  if (profile !== "strict") return null;
  const valid = judge && typeof judge.provider === "string" && judge.provider && typeof judge.model === "string" && judge.model;
  return { profile: "strict", judge: valid ? { provider: judge.provider as string, model: judge.model as string, thinkingOptionId: typeof judge.thinkingOptionId === "string" ? judge.thinkingOptionId : null } : null };
}

export async function profileFor(labels: Record<string, string> | null | undefined): Promise<ResolvedProfile | null> {
  if (!labels) return null;
  if (labels[JukeProfileLabel] === "strict") return { profile: "strict", judge: null };
  let map: { labels?: Record<string, Record<string, unknown>> };
  try {
    map = JSON.parse(await readFile(profilesPath(), "utf8"));
  } catch {
    return null;
  }
  for (const [key, values] of Object.entries(map.labels ?? {})) {
    const value = labels[key];
    const resolved = value === undefined ? null : entry(values?.[value]);
    if (resolved) return resolved;
  }
  return null;
}
