# Juke

Juke is an inference-first Paseo plugin. After a completed agent turn, it launches a short-lived judge, by default on the judged agent's provider and model (or a fixed judge model chosen in settings). The judge semantically decides whether the agent stopped early in one of four ways (the four "jukes"):

- **answered-instead-of-acting**: the user intended work, but the agent took the message as a question and only answered. This includes question-shaped requests ("Can you fix this?") and completion checks on previously requested work ("Did you fill in all the data?" → "Not yet; here's what's missing"). Genuine information-only questions are left alone.
- **announced-then-stopped**: the agent said it will do something ("I'll now…", "Let me…") and ended its turn without doing it.
- **stopped-at-next-steps**: the user's direction is clear, and the agent listed next steps that fit it, then asked "want me to…?" or just stopped. Legitimate questions are left alone: destructive, externally visible, or out-of-scope steps; real preference decisions; optional extras; and cases where the user said to hold off.
- **derailed-by-steering**: the user sent a mid-task message (status check, correction, added detail, side question) and the agent handled only that, dropping the original task. Left alone when the message actually redirected the work, paused it, or asked for a status-only answer.

The pattern names live in one list in `server/judge.ts` (`JukePatterns`); the prompt, verdict parsing, and tests all read from it. The pattern is used only for logging.

Only an inference verdict of `continue` sends the original agent a follow-up.

Juke deliberately contains no keyword lists, score thresholds, or rule-based intent/completion decisions. The only deterministic behavior is operational safety: JSON validation, discarding stale verdicts, and recognizing its own follow-up marker to prevent a loop.

The judge receives the timeline as untrusted evidence, does not use tools, and returns a constrained JSON verdict. It is archived after every assessment. Evidence is bounded to 48,000 characters using whole JSON items: user messages take priority over assistant outcomes and tool details, inline images are omitted, and retained items stay chronological. This prevents image payloads from erasing the request behind an interrupting status check.

Completed assessments log both `continue` and `leave-alone`, with the agent, judge, turn, and rationale, so a negative verdict is distinguishable from a judge that never ran.

## Development

```bash
npm run typecheck
paseo plugin install /home/jesse/Work/juke
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
```

`npm run eval` runs the judge prompt against a real model (default
`anthropic/claude-opus-5-5`, override with `JUKE_EVAL_MODEL`) over synthetic
transcripts for all four jukes, including indirect requests and completion checks,
and the cases that must be left alone (status-only questions, completed work,
real blockers, and unauthorized publishing). It costs
inference, so run it whenever the prompt changes rather than on every test run.

The suite covers verdict recovery from prose/fenced replies, the self-trigger
guard, and the role-ownership ancestry walk (including cycles and depth bounds).
