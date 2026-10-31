Juke checks completed agent turns for work that was requested but left unfinished. When its judge finds a reason to continue, Juke sends the agent a scoped follow-up.

Juke requires Paseo 0.14.x. Automatic assessment is on by default. In settings you can pause it, enable or disable individual checks, edit the judge prompt, and choose a judge provider, model, and reasoning level. By default it uses the judged agent's provider and model. Paid OpenRouter selections are refused.

Each assessment launches a short-lived judge agent. Juke sends bounded conversation messages and tool-call details to the judge's configured model provider, which may consume model quota. When delegated agents stop, an optional check also sends their recent results to the judge to decide whether an idle parent should continue. It skips its own follow-ups and Role Orchestrator-owned runs. Judgments are probabilistic and may be wrong; the agent's existing permission controls still apply.
