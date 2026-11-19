import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { JudgeProfile } from "./judge";

/** An agent can ask for a profile directly with this label. */
export const JukeProfileLabel = "juke.profile";

/**
 * Other plugins choose Juke's profile for agents they own without relabelling them: they write
 * `plugin-data/juke-profiles.json` as `{ "labels": { "<label key>": { "<label value>": "strict" } } }`.
 * Role Orchestrator maps its gate-enabled roles to "strict" this way, which also covers agents that
 * existed before the role was gated.
 */
const profilesPath = () => join(process.env.PASEO_HOME || join(homedir(), ".paseo"), "plugin-data", "juke-profiles.json");

export async function profileFor(labels: Record<string, string> | null | undefined): Promise<JudgeProfile | null> {
  if (!labels) return null;
  if (labels[JukeProfileLabel] === "strict") return "strict";
  let map: { labels?: Record<string, Record<string, string>> };
  try {
    map = JSON.parse(await readFile(profilesPath(), "utf8"));
  } catch {
    return null;
  }
  for (const [key, values] of Object.entries(map.labels ?? {})) {
    const value = labels[key];
    if (value !== undefined && values?.[value] === "strict") return "strict";
  }
  return null;
}
