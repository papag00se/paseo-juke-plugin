<div align="center">

![Paseo Juke — illustrated project cover](docs/media/hero.png)

# Paseo Juke

![Paseo compatibility](https://img.shields.io/badge/Paseo-0.9.1%E2%80%930.9.x-22c55e?style=flat-square)
![TypeScript](https://img.shields.io/badge/TypeScript-3178c6?style=flat-square&logo=typescript&logoColor=white)
![Platform](https://img.shields.io/badge/Platform-Daemon%20plugin-64748b?style=flat-square)

[Features](#features) · [Getting started](#getting-started) · [Compatibility](#compatibility) · [Reference](docs/REFERENCE.md)

</div>

🛑 Agents love to stop at *"Here's my plan…"* or *"Want me to go ahead?"* when you already asked them to do the work.

🧑‍⚖️ Juke catches that. After every finished turn, a short-lived judge reads what you asked and what the agent actually did. If the agent stopped short, Juke sends it back to work. If not, it stays out of the way.

## Features

| Feature | What you get |
| --- | --- |
| 🧠 Semantic review | A model judges intent and follow-through, not a keyword score |
| 🎯 Two continuation cases | Unperformed work and unnecessary permission questions |
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
