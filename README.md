# Juke

Juke is an inference-first Paseo plugin. After a completed agent turn, it launches a short-lived judge using the same provider. The judge semantically decides whether the agent stopped early in one of two ways:

- **unperformed-work**: the user asked for work and the agent ended its turn with a plan, a promise, or a description instead of doing it.
- **needless-permission**: the agent ended its turn asking "want me to…?" about a next step it clearly already knows, when that step serves a goal the user already stated. Legitimate questions are left alone: destructive, externally visible, or out-of-scope steps; real preference decisions; optional extras; and cases where the user said to hold off.

Only an inference verdict of `continue` sends the original agent a follow-up.

Juke deliberately contains no keyword lists, score thresholds, or rule-based intent/completion decisions. The only deterministic behavior is operational safety: JSON validation, discarding stale verdicts, and recognizing its own follow-up marker to prevent a loop.

The judge receives the timeline as untrusted evidence, does not use tools, and returns a constrained JSON verdict. It is archived after every assessment.

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
transcripts for both patterns and the cases that must be left alone. It costs
inference, so run it whenever the prompt changes rather than on every test run.

The suite covers verdict recovery from prose/fenced replies, the self-trigger
guard, and the role-ownership ancestry walk (including cycles and depth bounds).
