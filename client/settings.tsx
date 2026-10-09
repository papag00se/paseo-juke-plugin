import { usePaseo, useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsCard, SettingsSection, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { Text, View } from "react-native";
import { preferences } from "../shared/settings";

const SAME_AS_AGENT = "";
const MODEL_DEFAULT = "";

export function JukeSettings({ theme, layout }: PluginSurfaceProps) {
  const settings = useSettings(preferences);
  const paseo = usePaseo();
  const catalog = useQuery({ queryKey: ["juke", "provider-catalog"], queryFn: async () => (await paseo.providers.snapshot()).entries, staleTime: 30_000 });
  const text = { color: theme.colors.foreground }, muted = { color: theme.colors.foregroundMuted };
  if (settings.status !== "ready") return <View style={{ padding: layout.compact ? 12 : 20 }}><Text style={text}>{settings.status === "loading" ? "Loading settings…" : settings.error}</Text></View>;

  const values = settings.values;
  const save = (patch: Partial<typeof values>) => { void settings.save({ ...values, ...patch }, settings.revision); };
  // Keep a saved provider listed even if it is not ready right now, so the selection stays visible.
  const providers = (catalog.data ?? []).filter(entry => entry.enabled && (entry.status === "ready" || entry.provider === values.judgeProvider));
  const provider = providers.find(entry => entry.provider === values.judgeProvider);
  const models = (provider?.models ?? []).filter(model => model.isSelectable !== false);
  const model = models.find(candidate => candidate.id === values.judgeModel);
  const sameAsAgent = values.judgeProvider === SAME_AS_AGENT;

  return <View style={{ padding: layout.compact ? 12 : 20, gap: 16 }}>
    <SettingsSection title="Juke">
      <SettingsCard>
        <SettingsSwitch label="Automatically assess completed turns" value={values.enabled} disabled={settings.saving} onValueChange={enabled => save({ enabled })} hint="Turn this off to pause Juke. Pending assessments won't send follow-ups after this changes." />
      </SettingsCard>
      <Text style={muted}>After an agent finishes a turn, Juke checks whether it stopped at a plan, a promise or an unnecessary permission question. If so, Juke tells it to carry on.</Text>
    </SettingsSection>
    <SettingsSection title="Judge model">
      <SettingsCard>
        <SettingsSelect label="Provider" value={values.judgeProvider} disabled={settings.saving}
          options={[{ value: SAME_AS_AGENT, label: "Same as the agent being judged" }, ...providers.map(entry => ({ value: entry.provider, label: entry.label ?? entry.provider }))]}
          onValueChange={judgeProvider => save({ judgeProvider, judgeModel: "", judgeThinkingOptionId: null })} />
        {sameAsAgent ? null : <SettingsSelect label="Model" value={values.judgeModel} disabled={settings.saving}
          options={[{ value: "", label: "Choose a model" }, ...models.map(candidate => ({ value: candidate.id, label: candidate.label }))]}
          onValueChange={judgeModel => save({ judgeModel, judgeThinkingOptionId: models.find(candidate => candidate.id === judgeModel)?.defaultThinkingOptionId ?? null })} />}
        {sameAsAgent || !model?.thinkingOptions?.length ? null : <SettingsSelect label="Reasoning level" value={values.judgeThinkingOptionId ?? MODEL_DEFAULT} disabled={settings.saving}
          options={[{ value: MODEL_DEFAULT, label: "Model default" }, ...model.thinkingOptions.map(option => ({ value: option.id, label: option.label }))]}
          onValueChange={id => save({ judgeThinkingOptionId: id || null })} />}
      </SettingsCard>
      {!sameAsAgent && !values.judgeModel ? <Text style={text}>Choose a model. Until then, Juke uses the judged agent's model.</Text> : null}
      {!!settings.saveError && <Text accessibilityRole="alert" style={text}>{settings.saveError}</Text>}
      <Text style={muted}>Agents launched by Role Orchestrator are skipped, so the two never compete over the same turn. Each assessment is listed in this plugin's Logs menu.</Text>
    </SettingsSection>
  </View>;
}
