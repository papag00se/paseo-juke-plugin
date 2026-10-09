# Juke

Juke is an inference-first Paseo plugin. After a completed agent turn, it launches a short-lived judge, by default on the judged agent's provider and model (or a fixed judge model chosen in settings). The judge semantically decides whether the agent stopped early in one of nine ways (the "jukes"):

- **answered-instead-of-acting**: the user intended work, but the agent took the message as a question and only answered. This includes question-shaped requests ("Can you fix this?") and completion checks on previously requested work ("Did you fill in all the data?" → "Not yet; here's what's missing"). Genuine information-only questions are left alone.
- **announced-then-stopped**: the agent said it will do something ("I'll now…", "Let me…") and ended its turn without doing it.
- **stopped-at-next-steps**: the user's direction is clear, and the agent listed next steps that fit it, then asked "want me to…?" or just stopped. Legitimate questions are left alone: destructive, externally visible, or out-of-scope steps; real preference decisions; optional extras; and cases where the user said to hold off.
- **derailed-by-steering**: the user steered the agent mid-task (a correction, added detail or requirement, or status check) and the agent handled only the steer, dropping the original task. Left alone when the steer actually redirected the work, paused it, or asked for a status-only answer.
- **claimed-done-but-not**: the agent reported the task finished, but the evidence shows less: part of the scope, placeholders or TODOs, or a result it never checked ("tests should pass now" with no test run). The judge compares the claim to the tool calls; when much of the evidence was cut for size and nothing contradicts the claim, it trusts the claim.
- **made-up-blocker**: the agent declared itself stuck after one obstacle it could work around (another command, reading the error, a different path). Real blockers are left alone: things only the user can supply, or actions the user hasn't authorized.
- **asked-what-it-could-find**: the agent asked the user a factual question whose answer is earlier in the conversation or readable from the code, config, or a harmless command. Questions about the user's preferences or information only the user has are left alone.
- **handed-work-back**: the agent told the user to do in-scope steps it could do itself ("run this command to finish"). Steps that need the user's own credentials, hardware, accounts, or judgment, or that the user said they'd do, are left alone.
- **paused-on-its-own**: the agent stopped partway through authorized work with nothing blocking it, citing length, time, or a self-chosen checkpoint. Task length is never a reason to stop. Checkpoints the user asked for are left alone.

All jukes live in one list in `shared/jukes.ts`: each entry holds the id, the settings title and example, the rule the judge applies, and any juke-specific follow-up guidance. The settings screen, the judge prompt, verdict parsing, and tests all read from it.

Each juke can be turned off in settings (stored as `disabledJukes`, so new jukes start on). A turned-off juke is left out of the judge prompt, and the judge is told that behavior is acceptable so it doesn't report the same stop under a neighboring juke. A `continue` verdict must name its juke; if it names a turned-off one anyway, Juke logs it and sends nothing. With every juke off, no judge runs.

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
transcripts for every juke, including indirect requests and completion checks,
and the cases that must be left alone (status-only questions, completed work,
real blockers, unauthorized publishing, verified completion, questions only the user can answer, handovers needing the user's account, and checkpoints the user asked for). It costs
inference, so run it whenever the prompt changes rather than on every test run.

The suite covers verdict recovery from prose/fenced replies, the self-trigger
guard, and the role-ownership ancestry walk (including cycles and depth bounds).
