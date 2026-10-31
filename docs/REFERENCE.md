# Juke

Juke is an inference-first Paseo plugin. After a completed agent turn, it launches a short-lived judge, by default on the judged agent's provider and model (or a fixed judge model chosen in settings). The judge semantically decides whether the agent stopped early in one of ten ways (the "jukes"):

- **answered-instead-of-acting**: the user intended work, but the agent took the message as a question and only answered. This includes question-shaped requests ("Can you fix this?") and completion checks on previously requested work ("Did you fill in all the data?" → "Not yet; here's what's missing"). Genuine information-only questions are left alone.
- **announced-then-stopped**: the agent said it will do something ("I'll now…", "Let me…") and ended its turn without doing it.
- **stopped-at-next-steps**: the user's direction is clear, and the agent listed next steps that fit it, then asked "want me to…?" or just stopped. Legitimate questions are left alone: destructive, externally visible, or out-of-scope steps; real preference decisions; optional extras; and cases where the user said to hold off.
- **derailed-by-steering**: the user sent a mid-task message (status check, correction, added detail, side question) and the agent handled only that, dropping the original task. A steer is almost never a stop (the user has a stop button for that), so status checks and questions never count as one. Left alone only when the steer redirected the work or explicitly said to stop or hold.
- **claimed-done-but-not**: the agent reported the task finished, but the evidence shows less: part of the scope, placeholders or TODOs, or a result it never checked ("tests should pass now" with no test run). The judge compares the claim to the tool calls; when much of the evidence was cut for size and nothing contradicts the claim, it trusts the claim.
- **made-up-blocker**: the agent declared itself stuck after one obstacle it could work around (another command, reading the error, a different path). Real blockers are left alone: things only the user can supply, or actions the user hasn't authorized.
- **asked-what-it-could-find**: the agent asked the user a factual question whose answer is earlier in the conversation or readable from the code, config, or a harmless command. Questions about the user's preferences or information only the user has are left alone.
- **handed-work-back**: the agent told the user to do in-scope steps it could do itself ("run this command to finish"). Steps that need the user's own credentials, hardware, accounts, or judgment, or that the user said they'd do, are left alone.
- **abandoned-after-delegation**: the parent went idle after delegating, and the stopped workers' results reveal actionable work the parent should review, integrate, or continue. Complete work, genuine blockers, and user-directed stops are left alone.
- **paused-on-its-own**: the agent stopped partway through authorized work with nothing blocking it, citing length, time, or a self-chosen checkpoint. Task length is never a reason to stop. Checkpoints the user asked for are left alone.

The judge's instructions are editable under **Settings → Plugins → Juke → Settings → Judge prompt**. Save applies the edited prompt; reset saves the default from `shared/prompt.ts`. The host-scoped `judgePrompt` setting defaults to the original instructions for existing installations and rejects blank prompts or prompts longer than 32,000 characters. `{{checks}}`, `{{allowedNote}}`, and `{{patterns}}` are expanded once from the current per-juke switches; authorship and session-intent guidance and conversation evidence are always appended separately. Keep those placeholders and the JSON response instructions when customizing. Changes invalidate pending assessments, just like other settings. Verdict validation and disabled-juke enforcement remain in code regardless of the prompt.

All jukes live in one list in `shared/jukes.ts`: each entry holds the id, the settings title and example, the rule the judge applies, and any juke-specific follow-up guidance. The settings screen, the judge prompt, verdict parsing, and tests all read from it.

Each juke can be turned off in settings (stored as `disabledJukes`, so new jukes start on). A turned-off juke is left out of the judge prompt, and the judge is told that behavior is acceptable so it doesn't report the same stop under a neighboring juke. A `continue` verdict must name its juke; if it names a turned-off one anyway, Juke logs it and sends nothing. With every juke off, no judge runs.

When a child turn ends, the delegation check reads the full agent directory and reevaluates an idle parent only if all known, non-archived descendants have stopped and no one is waiting for permission. It supplies the parent conversation and the latest results of up to 20 descendants, recording omissions. It rechecks settings, parent and child activity before sending; a new turn invalidates the pending assessment. Role Orchestrator-owned runs remain excluded. Canceled child turns do not trigger a check. The check is event-driven while the plugin is running; it does not replay missed events after restart. User-edited judge prompts should retain the template placeholders to include the new check.

Only an inference verdict of `continue` sends the original agent a follow-up.

Juke deliberately contains no keyword lists, score thresholds, or rule-based intent/completion decisions. The only deterministic behavior is operational safety: JSON validation, discarding stale verdicts, and recognizing its own follow-up marker to prevent a loop.

### Subagent report classification

Paseo records a prompt sent by another agent as a `user_message` with no sender. Before each assessment, `server/provenance.ts` lists the parent's child agents by the `paseo.parent-agent-id` label (including archived children, excluding Juke's own judges), reads each child's canonical timeline, and collects sends addressed to the parent's agent ID:

- `send_agent_prompt` tool calls in any provider rendering (Pi's MCP gateway `{ tool: "paseo_send_agent_prompt", args }` or a direct MCP tool), excluding failed or canceled calls;
- shell commands running `paseo send` (or `paseo agent send`) that name the parent's ID, including loops over several IDs.

Each child's sends are paired in order with the first unmatched parent user message that is similar enough. Text is normalized first: common escapes (`\"`, `\n`, `\uXXXX`, shell `'\''`) are unescaped, whitespace collapsed, and case folded. Tool sends compare by character-bigram Dice similarity of at least 0.9; shell sends locate the message inside the command by its opening or closing words and apply the same threshold, ignoring messages shorter than 24 characters. Timing is a window, not an exact match: the parent message must arrive no earlier than one minute before the child was created and no later than six hours after the send. Rehydrated child timelines can restamp sends later than delivery, which only widens the window.

Matched messages enter the evidence as `subagent_report` items with the child's ID and title, in the supporting budget, and the judge is told they are never user instructions. Classification is best effort: if the child directory or a child timeline cannot be read, the error is logged and every unmarked message remains a possible user message. Child sends are cached per child until its `updatedAt` changes. Paseo's timeline for a long-lived child may hold only its latest native session, so sends from earlier sessions cannot be matched and those reports remain possible user messages.

The judge receives the timeline as untrusted evidence, does not use tools, and returns a constrained JSON verdict. It is archived after every assessment. Juke fetches the complete canonical timeline for every assessment and preserves every unmarked user-labeled message verbatim, in order, independently of the 48,000-character supporting-evidence budget. Known Juke and `<paseo-system>` envelopes, assistant messages, and tool details share that supporting budget; inline images are omitted. Paseo does not expose reliable sender identity, so Juke classifies subagent reports itself (below). Unmatched messages stay possible user messages, and the judge must infer intent from context without treating agent reports as instructions. Very long conversations may exceed the selected judge model's context window; the assessment fails visibly in plugin logs instead of silently omitting possible user instructions.

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

`npm run eval` runs the judge prompt against a real model over the synthetic
conversations in `eval/cases.ts`. It costs inference, so run it whenever the
prompt or a juke's rule changes rather than on every test run. The cases come
in three kinds:

- **core**: the original example of each juke, and the boundaries Juke must
  respect (status-only questions, completed work, real blockers, unauthorized
  publishing, preference decisions, checkpoints the user asked for);
- **variations**: several phrasings of each juke, plus look-alikes built to
  trick the judge in either direction;
- **switches**: stops with their juke turned off, which must be left alone, and
  every "send it back" variation repeated with its juke turned off, so a stop
  can't slip through under a juke that's still on.

```bash
npm run eval                              # every case once, default model
npm run eval -- --repeat 3                # each case three times, to expose flaky verdicts
npm run eval -- --only switches           # cases whose name or group contains the text
npm run eval -- --model openai-codex/gpt-6.1-sol
npm run eval -- --report eval/RESULTS.md  # also write a markdown report
```

The decision (send back or leave alone) and the juke label are scored
separately. Where a stop honestly fits two jukes, a case accepts either.
Latest results and what they changed are in `eval/RESULTS.md`.

The unit suite covers verdict parsing (prose, fences, and null fields), the
self-trigger guard, the role-ownership ancestry walk (including cycles and
depth bounds), and, for every juke, that turning it off removes it from the
prompt's checks, describes it as accepted behavior, and blocks its follow-up.
