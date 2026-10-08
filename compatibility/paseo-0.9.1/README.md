# Juke

Juke is an inference-first Paseo plugin. After a completed agent turn, it launches a short-lived judge, by default on the judged agent's provider and model. The judge semantically decides whether the agent stopped early in one of two ways:

- **unperformed-work**: the user wanted work and the agent ended its turn with a plan, promise, description, or status answer instead of doing it. This includes question-shaped requests and completion checks on previously requested work ("Did you fill in all the data?" → "Not yet; here's what's missing"). Genuine information-only or status-only questions are left alone.
- **needless-permission**: the agent ended its turn asking "want me to…?" about a next step it clearly already knows, when that step serves a goal the user already stated. Legitimate questions are left alone: destructive, externally visible, or out-of-scope steps; real preference decisions; optional extras; and cases where the user said to hold off.

Only an inference verdict of `continue` sends the original agent a follow-up.

Juke deliberately contains no keyword lists, score thresholds, or rule-based intent/completion decisions. The only deterministic behavior is operational safety: JSON validation, discarding stale verdicts, and recognizing its own follow-up marker to prevent a loop.

The judge receives the timeline as untrusted evidence, does not use tools, and returns a constrained JSON verdict. It is archived after every assessment. Evidence is bounded to 48,000 characters using whole JSON items: user messages take priority over assistant outcomes and tool details, inline images are omitted, and retained items stay chronological. This prevents image payloads from erasing the request behind an interrupting status check. A status check does not cancel outstanding work unless the user requests a pause or a status-only response.

Completed assessments log both `continue` and `leave-alone`, with the agent, judge, turn, and rationale, so a negative verdict is distinguishable from a judge that never ran.

## Settings

Open **Settings → Plugins → Juke → ⋯ → Settings**, or **Juke settings** in the Command Center. **Automatically assess completed turns** defaults on and saves immediately. Turn it off to pause assessments without disabling the plugin UI. Changing it invalidates pending assessments, even if it is subsequently turned back on; stale verdicts cannot send follow-ups. Existing judges are archived when their outstanding wait completes.

**Judge model** chooses who judges. *Same as the agent being judged* (the default) reuses the judged agent's live provider and model. Choosing a provider and model runs every judge on that model, with the optional reasoning level. Selections save immediately. A provider without a chosen model still falls back to the judged agent's model. Paid OpenRouter judges are refused either way.

## Development

```bash
npm run typecheck
paseo plugin install "$PWD"
paseo plugin ls
```

## Scope

Juke stays out of runs that Role Orchestration owns — the role agent, its
completion-gate and context helpers, and anything beneath them — because that
system runs its own completion judge. Ownership is resolved by walking the
agent's parent chain, since a subagent carries no role label of its own.

## Tests

```bash
npm run typecheck
npm test
npm run test:settings
```

`npm run eval` runs the judge prompt against a real model (default
`anthropic/claude-opus-5-5`, override with `JUKE_EVAL_MODEL`) over synthetic
transcripts for both patterns, including indirect requests and completion checks,
and the cases that must be left alone (status-only questions, completed work,
real blockers, and unauthorized publishing). It costs
inference, so run it whenever the prompt changes rather than on every test run.

The suite covers verdict recovery from prose/fenced replies, the self-trigger
guard, and the role-ownership ancestry walk (including cycles and depth bounds).
