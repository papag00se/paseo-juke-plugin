import type { PluginClientContext } from "@getpaseo/plugin/client";
import { NudgeItem, PauseItem } from "./client/nudge";
import { JukeSettings } from "./client/settings";
import { nudgeRowSchema, pauseAgent, pauseRowSchema, resumeAgent } from "./shared/nudge";

export default function contribute(client: PluginClientContext) {
  client.addSettingsScreen({ id: "settings", title: "Settings", icon: "Settings", Component: JukeSettings });
  client.addCommandCenterItem({ id: "settings", title: "Juke settings", icon: "Settings", context: "global", onSelect: ({ openSettings }) => openSettings("settings") });
  client.addTimelineRenderer({ kind: "nudge", version: 1, schema: nudgeRowSchema, Component: NudgeItem });
  client.addTimelineRenderer({ kind: "pause", version: 1, schema: pauseRowSchema, Component: PauseItem });
  client.addSlashCommand({
    name: "juke-pause", description: "Stop Juke from nudging this agent", argumentHint: "", context: "agent",
    async onSubmit({ agent, rpc }) { await rpc(pauseAgent, { agentId: agent.id }); },
  });
  client.addSlashCommand({
    name: "juke-resume", description: "Let Juke nudge this agent again", argumentHint: "", context: "agent",
    async onSubmit({ agent, rpc }) { await rpc(resumeAgent, { agentId: agent.id }); },
  });
  return () => {};
}
