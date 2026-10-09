<div align="center">

![Paseo Juke — illustrated project cover](docs/media/hero.png)

# Paseo Juke

![Paseo compatibility](https://img.shields.io/badge/Paseo-0.9.1%E2%80%930.9.x-22c55e?style=flat-square)
![TypeScript](https://img.shields.io/badge/TypeScript-3178c6?style=flat-square&logo=typescript&logoColor=white)
![Platform](https://img.shields.io/badge/Platform-Daemon%20plugin-64748b?style=flat-square)

[The four jukes](#the-four-jukes) · [Features](#features) · [Getting started](#getting-started) · [Compatibility](#compatibility) · [Reference](docs/REFERENCE.md)

</div>

🛑 Agents love to stop at *"Here's my plan…"* or *"Want me to go ahead?"* when you already asked them to do the work.

🧑‍⚖️ Juke catches that. After every finished turn, a short-lived judge reads what you asked and what the agent actually did. If the agent stopped short, Juke sends it back to work. If not, it stays out of the way.

## The four jukes

A "juke" is an agent faking the end of a turn while work is still owed. Juke catches four kinds:

| # | Juke | Example | What Juke does |
| --- | --- | --- | --- |
| 1 | **Answered instead of acting** — you wanted work done, the agent treated it as a question | *"Can you fix the typo?"* → *"Yes, it should say 'Installation'."* | Tells it to make the fix |
| 2 | **Announced, then stopped** — the agent says it will do something, then ends its turn | *"I'll rename getUser to fetchUser everywhere next."* (nothing renamed) | Tells it to do what it announced |
| 3 | **Stopped at next steps** — your direction is clear, the agent lists matching next steps, then asks to go ahead or just stops | *"Lint fails on an unused import. Want me to remove it?"* | Tells it to take those steps |
| 4 | **Derailed by steering** — you nudge the agent mid-task and it drops the task | *"Use zod for validation."* → *"Got it, zod is a better fit."* (task abandoned) | Tells it to apply your nudge and finish the task |

Juke leaves the agent alone when you only asked a question, asked for a plan or a status-only answer, said to hold off, or truly changed direction. It also stays out when the work is done or blocked, when the choice is genuinely yours, or when the next step is risky or out of scope (deleting, publishing, spending money).

The names above appear in the plugin's **Logs** with each verdict. [Exact judging rules →](docs/REFERENCE.md)

## Features

| Feature | What you get |
| --- | --- |
| 🧠 Semantic review | A model judges intent and follow-through, not a keyword score |
| 🎯 Four jukes | Each common way an agent stops early, below |
| 🚧 Clear boundaries | Real questions, genuine blockers and unauthorized actions are left alone |
| ⚖️ Your choice of judge | Reuse the judged agent's model, or pick a provider, model and reasoning level |
| 🔁 Loop protection | Stale verdicts, Juke's own follow-ups and Role Orchestrator runs are skipped |
| ⏸️ One-switch pause | Turn automatic assessments off without removing the plugin |

## How it fits

```mermaid
flowchart LR
    A[Agent completes a turn] --> B[Judge reviews the request and outcome]
    B --> C{Continue?}
    C -->|Yes| D[Send a scoped follow-up]
    C -->|No| E[Leave the agent alone]
    D --> F[Archive the judge]
    E --> F
```

## Getting started

```bash
git clone https://github.com/papag00se/paseo-juke-plugin.git
cd paseo-juke-plugin
npm ci --legacy-peer-deps
npm run typecheck
paseo plugin install "$PWD"
```

Open **Settings → Plugins → Juke → Settings**. Automatic assessment is on by default. Under **Judge model**, keep *Same as the agent being judged* or choose a provider, model and reasoning level. Every assessment runs a separate judge agent, so it uses model quota. Each verdict appears in the plugin's **Logs** menu.

![Juke settings in Paseo: the automatic assessment switch and the judge provider, model and reasoning level](docs/media/settings.png)

## Compatibility

Juke targets Paseo **0.9.1–0.9.x**. The pre-0.9.1 implementation is in Git history (before the Paseo 0.9.1 port became the only version).

Juke does not own execution permissions. It evaluates the user's existing task scope and leaves tool authorization to the agent harness. Role Orchestrator-owned runs are excluded because they have their own completion system.

## Development

```bash
npm run typecheck
npm test
```

`npm run test:settings` runs only the settings tests. `npm run eval` uses a real model and is separate from the unit suite.

[Judge behavior, settings, evidence limits, and tests →](docs/REFERENCE.md)
