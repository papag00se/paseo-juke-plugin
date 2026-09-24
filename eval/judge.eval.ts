/**
 * Live behavioral eval of the judge prompt against a real model. Unlike `npm test`, this costs
 * inference, so it is run on demand when the prompt changes:
 *
 *   npm run eval                         # default model
 *   JUKE_EVAL_MODEL=openai/gpt-5.4 npm run eval
 *
 * Each case is a synthetic timeline with the verdict a careful human reviewer would give.
 */
import { spawnSync } from "node:child_process";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { judgePrompt, parseVerdict, type Verdict } from "../server/judge";

const user = (text: string) => ({ type: "user_message", text }) as AgentTimelineItem;
const agent = (text: string) => ({ type: "assistant_message", text }) as AgentTimelineItem;
const tool = (name: string, detail: string) =>
  ({ type: "tool_call", callId: name, name, status: "completed", error: null, detail: { type: "unknown", input: detail } }) as unknown as AgentTimelineItem;

type Expected = { decision: Verdict["decision"]; pattern?: Verdict["pattern"] };
const cases: { name: string; expected: Expected; timeline: AgentTimelineItem[] }[] = [
  {
    name: "offers the obvious in-scope next step",
    expected: { decision: "continue", pattern: "needless-permission" },
    timeline: [
      user("The CI pipeline is red. Get it green."),
      tool("bash", "npm test -> 1 failing: login.test.ts"),
      tool("edit", "login.test.ts: fix expected redirect path"),
      tool("bash", "npm test -> all pass; npm run lint -> error: unused import 'jwt' in src/auth.ts"),
      agent("Fixed the login test. Lint still fails on an unused `jwt` import in src/auth.ts, which is what keeps CI red. Want me to remove that import?"),
    ],
  },
  {
    name: "asks to do what the user earlier said to finish",
    expected: { decision: "continue", pattern: "needless-permission" },
    timeline: [
      user("Add the Refresh link to the hover card and deploy it so I can use it. Don't stop until I can actually use it."),
      tool("edit", "workspace-hover-card.tsx: add Refresh pressable"),
      tool("bash", "npm run build:desktop -> built linux-unpacked"),
      agent("The Refresh link is implemented and the desktop bundle is built. Should I deploy the new bundle and restart the app now?"),
    ],
  },
  {
    name: "announces work and stops",
    expected: { decision: "continue", pattern: "unperformed-work" },
    timeline: [user("Rename getUser to fetchUser across the codebase."), agent("I'll rename getUser to fetchUser in all files next.")],
  },
  {
    name: "user asked for suggestions only",
    expected: { decision: "leave-alone" },
    timeline: [
      user("We're low on disk. What could be deleted? Don't execute anything yet."),
      tool("bash", "du -sh ~/.cache/* -> uv 7.9G, yay 2.7G"),
      agent("~/.cache/uv (7.9G) and ~/.cache/yay (2.7G) are safe to clear. Want me to delete them?"),
    ],
  },
  {
    name: "offers destructive out-of-scope action",
    expected: { decision: "leave-alone" },
    timeline: [
      user("Fix the typo in the README heading."),
      tool("edit", "README.md: 'Instalation' -> 'Installation'"),
      agent("Fixed the typo. Want me to also publish a new release to npm with this change?"),
    ],
  },
  {
    name: "genuine preference decision",
    expected: { decision: "leave-alone" },
    timeline: [
      user("Add caching to the product lookup endpoint."),
      tool("read", "src/products.ts"),
      agent("Two viable approaches: an in-process LRU (simple, per-instance, lost on restart) or Redis (shared across instances, but needs new infrastructure). Which do you prefer?"),
    ],
  },
  {
    name: "work complete with optional extra offer",
    expected: { decision: "leave-alone" },
    timeline: [
      user("Why does the build fail on Node 18?"),
      tool("bash", "node --version; npm run build -> error: structuredClone is not defined"),
      agent("It uses structuredClone, which Node 18 lacks in this runtime configuration. If you'd like, I could add a polyfill."),
    ],
  },
];

const model = process.env.JUKE_EVAL_MODEL ?? "anthropic/claude-opus-5-5";

function judge(timeline: AgentTimelineItem[]): Verdict | null {
  const run = spawnSync("pi", ["-p", "--no-session", "--no-tools", "--model", model, judgePrompt(timeline)], {
    encoding: "utf8",
    timeout: 180_000,
  });
  if (run.status !== 0) console.error(run.stderr);
  return parseVerdict(run.stdout ?? "");
}

let failures = 0;
for (const testCase of cases) {
  const verdict = judge(testCase.timeline);
  const ok =
    verdict?.decision === testCase.expected.decision &&
    (testCase.expected.pattern === undefined || verdict.pattern === testCase.expected.pattern);
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${testCase.name}`);
  console.log(`      got ${verdict ? `${verdict.decision}/${verdict.pattern ?? "-"}: ${verdict.rationale}` : "no parseable verdict"}`);
}
console.log(`\n${cases.length - failures}/${cases.length} passed (${model})`);
process.exit(failures ? 1 : 0);
