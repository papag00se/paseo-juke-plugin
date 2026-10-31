import { useRpc, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Jukes } from "../shared/jukes";
import { cancelNudge, sendNudgeNow, type NudgeRow, type PauseRow } from "../shared/nudge";

/** A pending row older than this outlived its daemon (for example across a restart). */
const STALE_AFTER_MS = 60_000;

function patternTitle(pattern: string): string {
  return Jukes.find(juke => juke.id === pattern)?.title ?? pattern;
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

const OUTCOME: Record<Exclude<NudgeRow["state"], "pending">, string> = {
  sent: "Juke nudged the agent",
  canceled: "Juke nudge canceled",
  superseded: "Juke nudge withdrawn: the agent started another turn",
  paused: "Juke nudge withdrawn: Juke is paused for this agent",
};

export function NudgeItem({ agentId, item, theme }: PluginTimelineItemProps<NudgeRow>) {
  const row = item.data;
  const pending = row.state === "pending";
  const now = useNow(pending);
  const cancel = useRpc(cancelNudge);
  const sendNow = useRpc(sendNudgeNow);
  const [busy, setBusy] = useState(false);
  const remaining = Math.max(0, Math.ceil((row.deadline - now) / 1000));
  const stale = pending && now - row.deadline > STALE_AFTER_MS;
  const act = (action: () => Promise<unknown>) => { setBusy(true); void action().finally(() => setBusy(false)); };
  const muted = { color: theme.colors.foregroundMuted, fontSize: 13 };
  const title = row.state !== "pending" ? OUTCOME[row.state] : stale ? "Juke nudge expired" : remaining > 0 ? `Juke will nudge in ${remaining}s` : "Juke is sending its nudge…";

  return <View style={{ gap: 6, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 10, padding: 10, backgroundColor: theme.colors.surface1 }}>
    <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>{title}</Text>
    <Text style={muted}>{patternTitle(row.pattern)}: {row.followUp}</Text>
    {pending && !stale ? <View style={{ flexDirection: "row", gap: 8 }}>
      <Pressable accessibilityRole="button" disabled={busy} onPress={() => act(() => cancel({ agentId }))}
        style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface2 }}>
        <Text style={{ color: theme.colors.foreground }}>Cancel</Text>
      </Pressable>
      <Pressable accessibilityRole="button" disabled={busy} onPress={() => act(() => sendNow({ agentId }))}
        style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, backgroundColor: theme.colors.accent }}>
        <Text style={{ color: theme.colors.accentForeground }}>Send now</Text>
      </Pressable>
    </View> : null}
  </View>;
}

export function PauseItem({ item, theme }: PluginTimelineItemProps<PauseRow>) {
  const { paused, autoResumeMinutes } = item.data;
  const text = !paused
    ? "Juke resumed for this agent."
    : autoResumeMinutes === null
      ? "Juke paused for this agent until you run /juke-resume."
      : `Juke paused for this agent. It resumes ${autoResumeMinutes} minute${autoResumeMinutes === 1 ? "" : "s"} after your latest message, or when you run /juke-resume.`;
  return <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>{text}</Text>;
}
