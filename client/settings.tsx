import { usePaseo, useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsSection, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import { Jukes, type JukeId } from "../shared/jukes";
import { preferences } from "../shared/settings";
import { DefaultJudgePrompt, JudgePromptLimit } from "../shared/prompt";

const SAME_AS_AGENT = "";
const DelayChoices = [0, 5, 10, 15, 30, 60, 120];
const ResumeChoices = [1, 2, 5, 10, 15, 30, 60, 120];
/** Keep a saved value listed even if it isn't one of the presets. */
const withCurrent = (choices: readonly number[], current: number) => choices.includes(current) ? choices : [...choices, current].sort((a, b) => a - b);
const MODEL_DEFAULT = "";

export function JukeSettings({ theme, layout }: PluginSurfaceProps) {
  const settings = useSettings(preferences);
  const paseo = usePaseo();
  const catalog = useQuery({ queryKey: ["juke", "provider-catalog"], queryFn: async () => (await paseo.providers.snapshot()).entries, staleTime: 30_000 });
  const text = { color: theme.colors.foreground }, muted = { color: theme.colors.foregroundMuted };
  if (settings.status !== "ready") return <View style={{ padding: layout.compact ? 12 : 20 }}><Text style={text}>{settings.status === "loading" ? "Loading settings…" : settings.error}</Text></View>;

  const values = settings.values;
  const save = (patch: Partial<typeof values>) => { void settings.save({ ...values, ...patch }, settings.revision); };
  const toggleJuke = (id: JukeId, on: boolean) => save({ disabledJukes: on ? values.disabledJukes.filter(other => other !== id) : [...values.disabledJukes, id] });

  return <ScrollView contentContainerStyle={{ padding: layout.compact ? 12 : 20, gap: 16 }}>
    <SettingsSection title="Juke">
      <SettingsCard>
        <SettingsSwitch label="Automatically assess completed turns" value={values.enabled} disabled={settings.saving} onValueChange={enabled => save({ enabled })} hint="Turn this off to pause Juke. Pending assessments won't send follow-ups after this changes." />
      </SettingsCard>
      <Text style={muted}>After an agent finishes a turn, Juke checks whether it stopped before the work was done. If so, Juke tells it to carry on.</Text>
    </SettingsSection>
    <SettingsSection title="Before Juke nudges">
      <SettingsCard>
        <SettingsSelect label="Wait before nudging" value={String(values.nudgeDelaySeconds)} disabled={settings.saving}
          options={withCurrent(DelayChoices, values.nudgeDelaySeconds).map(seconds => ({ value: String(seconds), label: seconds === 0 ? "Don't wait" : `${seconds} seconds` }))}
          onValueChange={value => save({ nudgeDelaySeconds: Number(value) })} />
        <SettingsSwitch label="Resume automatically after /juke-pause" value={values.pauseAutoResume} disabled={settings.saving}
          hint="Any activity from you or the agent restarts the count. Otherwise a paused agent stays paused until /juke-resume." onValueChange={pauseAutoResume => save({ pauseAutoResume })} />
        {values.pauseAutoResume ? <SettingsSelect label="Resume after this much inactivity" value={String(values.pauseAutoResumeMinutes)} disabled={settings.saving}
          options={withCurrent(ResumeChoices, values.pauseAutoResumeMinutes).map(minutes => ({ value: String(minutes), label: `${minutes} minute${minutes === 1 ? "" : "s"}` }))}
          onValueChange={value => save({ pauseAutoResumeMinutes: Number(value) })} /> : null}
      </SettingsCard>
      <Text style={muted}>A nudge shows a countdown in the chat with Cancel and Send now. Sending a message of your own before it runs out withdraws it. Type /juke-pause to stop Juke for one agent.</Text>
    </SettingsSection>
    <SettingsSection title="What Juke catches">
      <SettingsCard>
        {Jukes.map(juke => <SettingsSwitch key={juke.id} label={juke.title} hint={juke.example} value={!values.disabledJukes.includes(juke.id)}
          disabled={settings.saving || !values.enabled} onValueChange={on => toggleJuke(juke.id, on)} />)}
      </SettingsCard>
      <Text style={muted}>Turn one off to let agents stop that way without a nudge.</Text>
    </SettingsSection>
    <PromptEditor key={values.judgePrompt} value={values.judgePrompt} saving={settings.saving} theme={theme} onSave={judgePrompt => save({ judgePrompt })} />
    <JudgeModelSection title="Judge model" sameLabel="Same as the agent being judged" fallback="the judged agent's model"
      choice={{ provider: values.judgeProvider, model: values.judgeModel, thinking: values.judgeThinkingOptionId }}
      onChange={next => save({ judgeProvider: next.provider, judgeModel: next.model, judgeThinkingOptionId: next.thinking })}
      providers={catalog.data ?? []} saving={settings.saving} theme={theme}
      note="Each agent keeps one judge session that only receives what happened since its last verdict, so the provider can reuse its cache. Agents whose owning plugin asks for whole-ask checking (Role Orchestrator roles) use that plugin's judge setting instead. Each assessment is listed in this plugin's Logs menu." />
    {!!settings.saveError && <Text accessibilityRole="alert" style={text}>{settings.saveError}</Text>}
  </ScrollView>;
}

type ProviderEntry = Awaited<ReturnType<ReturnType<typeof usePaseo>["providers"]["snapshot"]>>["entries"][number];
type Choice = { provider: string; model: string; thinking: string | null };

function JudgeModelSection({ title, sameLabel, fallback, choice, onChange, providers: all, saving, theme, note }: {
  title: string; sameLabel: string; fallback: string; choice: Choice; onChange: (next: Choice) => void;
  providers: readonly ProviderEntry[]; saving: boolean; theme: PluginSurfaceProps["theme"]; note: string;
}) {
  // Keep a saved provider listed even if it is not ready right now, so the selection stays visible.
  const providers = all.filter(entry => entry.enabled && (entry.status === "ready" || entry.provider === choice.provider));
  const provider = providers.find(entry => entry.provider === choice.provider);
  const models = (provider?.models ?? []).filter(model => model.isSelectable !== false);
  const model = models.find(candidate => candidate.id === choice.model);
  const same = choice.provider === SAME_AS_AGENT;
  return <SettingsSection title={title}>
    <SettingsCard>
      <SettingsSelect label="Provider" value={choice.provider} disabled={saving}
        options={[{ value: SAME_AS_AGENT, label: sameLabel }, ...providers.map(entry => ({ value: entry.provider, label: entry.label ?? entry.provider }))]}
        onValueChange={provider => onChange({ provider, model: "", thinking: null })} />
      {same ? null : <SettingsSelect label="Model" value={choice.model} disabled={saving}
        options={[{ value: "", label: "Choose a model" }, ...models.map(candidate => ({ value: candidate.id, label: candidate.label }))]}
        onValueChange={id => onChange({ ...choice, model: id, thinking: models.find(candidate => candidate.id === id)?.defaultThinkingOptionId ?? null })} />}
      {same || !model?.thinkingOptions?.length ? null : <SettingsSelect label="Reasoning level" value={choice.thinking ?? MODEL_DEFAULT} disabled={saving}
        options={[{ value: MODEL_DEFAULT, label: "Model default" }, ...model.thinkingOptions.map(option => ({ value: option.id, label: option.label }))]}
        onValueChange={id => onChange({ ...choice, thinking: id || null })} />}
    </SettingsCard>
    {!same && !choice.model ? <Text style={{ color: theme.colors.foreground }}>Choose a model. Until then, Juke uses {fallback}.</Text> : null}
    <Text style={{ color: theme.colors.foregroundMuted }}>{note}</Text>
  </SettingsSection>;
}

function PromptEditor({ value, saving, theme, onSave }: {
  value: string; saving: boolean; theme: PluginSurfaceProps["theme"]; onSave: (prompt: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const valid = draft.trim().length > 0 && draft.trim().length <= JudgePromptLimit;
  return <SettingsSection title="Judge prompt">
    <Text style={{ color: theme.colors.foregroundMuted }}>Edit the instructions used for new assessments. {"{{checks}}"} inserts enabled checks, {"{{allowedNote}}"} explains disabled checks, and {"{{patterns}}"} lists valid verdict patterns. Session-intent guidance and conversation evidence are always appended automatically. Keep the JSON response instructions so Juke can read the verdict.</Text>
    <TextInput accessibilityLabel="Judge prompt" multiline textAlignVertical="top" value={draft}
      onChangeText={setDraft} editable={!saving} maxLength={JudgePromptLimit}
      style={{ color: theme.colors.foreground, backgroundColor: theme.colors.surface0, borderColor: theme.colors.border, borderWidth: 1, borderRadius: 8, padding: 12, minHeight: 240, maxHeight: 480 }} />
    {!valid && <Text accessibilityRole="alert" style={{ color: theme.colors.foreground }}>Enter a non-empty prompt of at most {JudgePromptLimit} characters.</Text>}
    <SettingsCard>
      <SettingsAction label="Apply prompt changes" actionLabel="Save prompt" disabled={saving || !valid || draft.trim() === value} onPress={() => onSave(draft.trim())} />
      <SettingsAction label="Restore the original instructions" actionLabel="Reset to default" disabled={saving || (value === DefaultJudgePrompt && draft === DefaultJudgePrompt)} onPress={() => { setDraft(DefaultJudgePrompt); onSave(DefaultJudgePrompt); }} />
    </SettingsCard>
  </SettingsSection>;
}
