import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Background work published by the Background Work plugin (`plugin-data/background-work.json`):
 * processes left running in each agent's scope and systemd services an agent launched. Without that
 * plugin the file is absent and the judge is simply not told about background work.
 */
const file = () => join(process.env.PASEO_HOME || join(homedir(), ".paseo"), "plugin-data", "background-work.json");
type Snapshot = { scannedAt: number; agents: Record<string, Array<Record<string, unknown>>> };

async function read(): Promise<Snapshot | null> {
  try {
    const parsed = JSON.parse(await readFile(file(), "utf8"));
    return typeof parsed?.scannedAt === "number" && parsed.agents && typeof parsed.agents === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The background work of an agent and its subagents, as judge evidence. The publisher refreshes the
 * file when a turn ends, so wait briefly for a scan taken after `since`; an older one is labelled with
 * its age rather than dropped.
 */
export async function backgroundEvidence(agentIds: readonly string[], since: number, waitMs = 3_000): Promise<string | null> {
  let snapshot = await read();
  for (const deadline = Date.now() + waitMs; snapshot && snapshot.scannedAt < since && Date.now() < deadline;) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    snapshot = await read();
  }
  if (!snapshot) return null;
  const now = Date.now();
  const items = agentIds.flatMap((agentId) => (snapshot!.agents[agentId] ?? []).map((item) => ({
    agentId,
    kind: item.kind,
    ...(item.kind === "service" ? { unit: item.unit } : { pid: item.pid, processCount: item.processCount }),
    command: String(item.command ?? "").slice(0, 300),
    runningForSeconds: typeof item.startedAt === "number" ? Math.round((now - item.startedAt) / 1000) : null,
  })));
  const age = Math.round((now - snapshot.scannedAt) / 1000);
  return `Background work still running for this agent and its subagents (processes in their scopes and systemd services they launched; scanned ${age}s ago; evidence of in-flight work, not proof that it covers the ask): ${JSON.stringify(items.slice(0, 40))}${items.length > 40 ? ` (${items.length - 40} more omitted)` : ""}`;
}
