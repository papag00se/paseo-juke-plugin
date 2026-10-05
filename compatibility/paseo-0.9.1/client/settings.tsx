import { useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsCard, SettingsSection, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { Text, View } from "react-native";
import { preferences } from "../shared/settings";

export function JukeSettings({ theme, layout }: PluginSurfaceProps) {
  const settings = useSettings(preferences);
  const text = { color: theme.colors.foreground }, muted = { color: theme.colors.foregroundMuted };
  return <View style={{ padding: layout.compact ? 12 : 20, gap: 16 }}>
    <SettingsSection title="Juke">
      {settings.status === "ready" ? <SettingsCard>
        <SettingsSwitch label="Automatically assess completed turns" value={settings.values.enabled} disabled={settings.saving} onValueChange={enabled => { void settings.save({ ...settings.values, enabled }, settings.revision); }} hint="Turn this off to pause Juke while keeping its settings available. Pending assessments will not send follow-ups after this setting changes." />
      </SettingsCard> : <Text style={text}>{settings.status === "loading" ? "Loading settings…" : settings.error}</Text>}
      {!!settings.saveError && <Text accessibilityRole="alert" style={text}>{settings.saveError}</Text>}
      <Text style={muted}>After a completed turn, Juke judges whether requested work was left at a plan/promise or an unnecessary permission question. Only a continue verdict sends a follow-up.</Text>
    </SettingsSection>
    <SettingsSection title="Judge behavior">
      <Text style={text}>Provider and model: reuse the original agent's provider and model.</Text>
      <Text style={muted}>There is no separate judge-model override. Paid OpenRouter selections are refused. Role Orchestrator-owned agents and Juke's own follow-ups are excluded to avoid competing judges and loops.</Text>
      <Text style={muted}>Judges are short-lived and archived after assessment. Existing inference rules and prompts are unchanged. Assessment details are available in the plugin's Logs menu.</Text>
    </SettingsSection>
  </View>;
}
