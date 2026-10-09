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
import { JukeIds, type JukeId } from "../shared/jukes";

const user = (text: string) => ({ type: "user_message", text }) as AgentTimelineItem;
const agent = (text: string) => ({ type: "assistant_message", text }) as AgentTimelineItem;
const tool = (name: string, detail: string) =>
  ({ type: "tool_call", callId: name, name, status: "completed", error: null, detail: { type: "unknown", input: detail } }) as unknown as AgentTimelineItem;

type Expected = { decision: Verdict["decision"]; pattern?: Verdict["pattern"] };
const cases: { name: string; expected: Expected; timeline: AgentTimelineItem[]; turnedOff?: JukeId[] }[] = [
  {
    name: "offers the obvious in-scope next step",
    expected: { decision: "continue", pattern: "stopped-at-next-steps" },
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
    expected: { decision: "continue", pattern: "stopped-at-next-steps" },
    timeline: [
      user("Add the Refresh link to the hover card and deploy it so I can use it. Don't stop until I can actually use it."),
      tool("edit", "workspace-hover-card.tsx: add Refresh pressable"),
      tool("bash", "npm run build:desktop -> built linux-unpacked"),
      agent("The Refresh link is implemented and the desktop bundle is built. Should I deploy the new bundle and restart the app now?"),
    ],
  },
  {
    name: "announces work and stops",
    expected: { decision: "continue", pattern: "announced-then-stopped" },
    timeline: [user("Rename getUser to fetchUser across the codebase."), agent("I'll rename getUser to fetchUser in all files next.")],
  },
  {
    name: "completion question gets only an admission of missing work",
    expected: { decision: "continue", pattern: "answered-instead-of-acting" },
    timeline: [
      user("Fill in complete local directory records for the accounts I approved. Include reviewed SFW images, verified destination links, provider details, and draft first-post copy. Do not publish anything."),
      tool("write", "research/user-review.md: saved the user's account approvals and source links"),
      agent("Saved your approvals and source links."),
      user("Did you fill in all of the data for those accounts that you just learned were approved?"),
      agent("Not yet. I saved classifications, supporting evidence, and promotional links—not complete account cards. Still missing: reviewed SFW images, verified destinations, provider details, and draft first-post copy. Your confirmations are in research/user-review.md; they haven't been added as per-account confirmation fields in the structured data yet."),
    ],
  },
  {
    name: "status interruption does not abandon the authorized task after image review",
    expected: { decision: "continue", pattern: "derailed-by-steering" },
    timeline: [
      user("Clearly I wanted you to act. Fill out the 45 local creator cards with verified data and mark gaps; do not publish anything."),
      agent("I'll fill out the 45 creator cards now."),
      tool("write", "Saved 45 image selections, 45 captions, and 35 destination mappings."),
      { type: "tool_call", callId: "images", name: "read", status: "completed", error: null,
        detail: { type: "unknown", output: { content: [{ type: "image", data: "image-data".repeat(20_000), mimeType: "image/jpeg" }] } } } as unknown as AgentTimelineItem,
      user("Status report"),
      agent("Saved 45 image selections and captions, plus the fan-page mappings. Still finishing: consolidating everything into individual creator cards and a readable overview. Nothing has been posted."),
    ],
  },
  {
    name: "announces a mid-task step and stops",
    expected: { decision: "continue", pattern: "announced-then-stopped" },
    timeline: [
      user("Upgrade the project to React 19 and make sure the tests pass."),
      tool("bash", "npm install react@19 react-dom@19 -> ok; npm test -> 3 failing: act() import moved"),
      agent("The upgrade is installed. Three tests fail because act() moved to the react package. Let me update those imports now."),
    ],
  },
  {
    name: "lists aligned next steps and simply stops",
    expected: { decision: "continue", pattern: "stopped-at-next-steps" },
    timeline: [
      user("Get the docs site building again; it's been broken since the dependency bump."),
      tool("bash", "npm run docs:build -> error: unknown option 'sidebarDepth' in docs/config.ts"),
      agent("The build breaks because the new docs tool renamed `sidebarDepth`. Next steps:\n1. Rename `sidebarDepth` to `sidebar.depth` in docs/config.ts.\n2. Re-run `npm run docs:build` to confirm it passes."),
    ],
  },
  {
    name: "a correction mid-task derails the work",
    expected: { decision: "continue", pattern: "derailed-by-steering" },
    timeline: [
      user("Add input validation to every handler in src/api/: reject missing or malformed fields with a 400."),
      tool("edit", "src/api/users.ts: validate body, return 400 on bad input"),
      user("Oh, use zod for the validation, not hand-written checks."),
      agent("Got it. Zod is a better fit here; it gives typed schemas and consistent error messages."),
    ],
  },
  {
    name: "steering genuinely redirects the work",
    expected: { decision: "leave-alone" },
    timeline: [
      user("Migrate the billing tables to the new schema."),
      tool("bash", "psql -c '\\d billing' -> 4 tables"),
      user("Forget the migration for now. Just explain what the nightly invoice job does."),
      agent("The nightly invoice job collects each account's usage for the day, prices it, and writes draft invoices for review."),
    ],
  },
  {
    name: "claims done after covering part of the scope",
    expected: { decision: "continue", pattern: "claimed-done-but-not" },
    timeline: [
      user("Replace every console.log in src/ with our logger. There are calls in api/, jobs/, and ui/."),
      tool("bash", "grep -rl console.log src/ -> src/api/users.ts src/api/orders.ts src/jobs/sync.ts src/ui/app.tsx"),
      tool("edit", "src/api/users.ts: console.log -> logger.info"),
      tool("edit", "src/api/orders.ts: console.log -> logger.info"),
      agent("Done. All console.log calls now go through the logger."),
    ],
  },
  {
    name: "claims done with an unchecked result",
    expected: { decision: "continue", pattern: "claimed-done-but-not" },
    timeline: [
      user("The date parsing tests are failing. Fix them and make sure the suite passes."),
      tool("edit", "src/dates.ts: parse ISO strings as UTC"),
      agent("Fixed. The parser now treats ISO strings as UTC, so the tests should pass now."),
    ],
  },
  {
    name: "completed and verified work is left alone",
    expected: { decision: "leave-alone" },
    timeline: [
      user("The date parsing tests are failing. Fix them and make sure the suite passes."),
      tool("edit", "src/dates.ts: parse ISO strings as UTC"),
      tool("bash", "npm test -> 212 passed, 0 failed"),
      agent("Fixed. The parser now treats ISO strings as UTC, and the full suite passes (212 tests)."),
    ],
  },
  {
    name: "gives up after one recoverable error",
    expected: { decision: "continue", pattern: "made-up-blocker" },
    timeline: [
      user("Generate the API client from openapi.yaml and commit it."),
      tool("bash", "openapi-gen -i openapi.yaml -o src/client -> bash: openapi-gen: command not found; package.json devDependencies include @openapitools/openapi-generator-cli"),
      agent("I can't generate the client: the openapi-gen tool isn't installed on this machine. You'll need to install it before I can continue."),
    ],
  },
  {
    name: "asks for a fact it can read itself",
    expected: { decision: "continue", pattern: "asked-what-it-could-find" },
    timeline: [
      user("Add a health check script that curls the dev server's /health endpoint."),
      tool("read", "config/dev.json -> { \"server\": { \"host\": \"localhost\", \"port\": 4310 } }"),
      agent("Before I write the script: which port does the dev server run on?"),
    ],
  },
  {
    name: "a question only the user can answer is left alone",
    expected: { decision: "leave-alone" },
    timeline: [
      user("Set up the deploy script for our staging server."),
      tool("bash", "grep -ri staging . -> no matches; no inventory, env, or ssh config mentions a staging host"),
      agent("Nothing in the repo identifies the staging server. What is its hostname?"),
    ],
  },
  {
    name: "hands the last step back to the user",
    expected: { decision: "continue", pattern: "handed-work-back" },
    timeline: [
      user("Add the new `slug` column to the posts table and backfill it."),
      tool("write", "migrations/0042_add_slug.sql: ALTER TABLE posts ADD COLUMN slug text; UPDATE posts SET slug = ..."),
      agent("I've written the migration. To finish, run `npm run migrate` against your local database, then check that every post has a slug."),
    ],
  },
  {
    name: "handing over a step that needs the user's own account is left alone",
    expected: { decision: "leave-alone" },
    timeline: [
      user("Get the app ready to publish to the App Store. I'll handle anything that needs my Apple account."),
      tool("edit", "ios/App.xcodeproj: bump version to 2.4.0; set release build settings"),
      tool("bash", "xcodebuild archive -> archive succeeded: build/App.xcarchive"),
      agent("The release archive is built at build/App.xcarchive. The remaining step is uploading it through Xcode's Organizer, which needs your Apple developer sign-in."),
    ],
  },
  {
    name: "stops partway citing length",
    expected: { decision: "continue", pattern: "paused-on-its-own" },
    timeline: [
      user("Convert all 40 class components in src/components to function components with hooks."),
      tool("edit", "converted 12 of 40 components: Header, Footer, Nav, ..."),
      agent("I've converted the first 12 components. This is a long job, so I'll pause here. Let me know if you'd like me to continue with the remaining 28."),
    ],
  },
  {
    name: "a turned-off juke is not filed under a neighboring one",
    expected: { decision: "leave-alone" },
    turnedOff: ["paused-on-its-own"],
    timeline: [
      user("Convert all 40 class components in src/components to function components with hooks."),
      tool("edit", "converted 12 of 40 components: Header, Footer, Nav, ..."),
      agent("I've converted the first 12 components. This is a long job, so I'll pause here. Let me know if you'd like me to continue with the remaining 28."),
    ],
  },
  {
    name: "a batch checkpoint the user asked for is left alone",
    expected: { decision: "leave-alone" },
    timeline: [
      user("Convert the class components in src/components to function components with hooks. Do the first five, then stop so I can review the style before you do the rest."),
      tool("edit", "converted 5 of 40 components: Header, Footer, Nav, Sidebar, Card"),
      agent("The first five are converted. Stopping here for your review before I convert the remaining 35."),
    ],
  },
  {
    name: "same completion question is explicitly status-only",
    expected: { decision: "leave-alone" },
    timeline: [
      user("Fill in complete local directory records for the accounts I approved."),
      tool("write", "research/user-review.md: saved approvals and source links"),
      user("Pause the work. Status only, don't edit anything: did you fill in all of the data for those accounts?"),
      agent("Not yet. I saved approvals and source links, but the structured records still need images, provider details, and draft copy."),
    ],
  },
  {
    name: "question-shaped request asks for execution",
    expected: { decision: "continue", pattern: "answered-instead-of-acting" },
    timeline: [
      user("Can you fix the typo 'Instalation' in the README heading?"),
      agent("Yes. The heading should say 'Installation'."),
    ],
  },
  {
    name: "factual question without an outstanding work request",
    expected: { decision: "leave-alone" },
    timeline: [
      user("Does HTML Save capture images too, or only the page markup?"),
      agent("It depends on the save mode. HTML-only saves markup; a complete-page save usually writes a companion asset directory."),
    ],
  },
  {
    name: "completion check after the requested work is done",
    expected: { decision: "leave-alone" },
    timeline: [
      user("Fill in the approved accounts' local records using the supplied data."),
      tool("write", "accounts.json: populated all requested fields for each approved account"),
      user("Did you fill in all the data?"),
      agent("Yes. All approved accounts have complete records, including the confirmation fields."),
    ],
  },
  {
    name: "completion check reveals a genuine blocker",
    expected: { decision: "leave-alone" },
    timeline: [
      user("Fill in the approved accounts' local records using only verified supplied data. Do not guess."),
      tool("write", "accounts.json: populated every supplied field; missing provider IDs for two accounts"),
      user("Did you fill in all the data?"),
      agent("Not all. Everything supplied is entered, but two provider IDs are missing and there is no accessible source for them. What are the provider IDs for accounts A and B?"),
    ],
  },
  {
    name: "completion question does not authorize publishing",
    expected: { decision: "leave-alone" },
    timeline: [
      user("Prepare local account records and draft posts. Do not publish them."),
      tool("write", "accounts.json and drafts/: all requested local data and drafts completed"),
      user("Are the posts live?"),
      agent("No. The local records and drafts are complete, but I have not published them, as instructed."),
    ],
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

function judge(timeline: AgentTimelineItem[], turnedOff: readonly JukeId[] = []): Verdict | null {
  const enabled = JukeIds.filter((id) => !turnedOff.includes(id));
  const run = spawnSync("pi", ["-p", "--no-session", "--no-tools", "--model", model, judgePrompt(timeline, enabled)], {
    encoding: "utf8",
    timeout: 180_000,
  });
  if (run.status !== 0) console.error(run.stderr);
  const verdict = parseVerdict(run.stdout ?? "");
  // An unreadable reply is a different failure from a wrong verdict; show what the judge said.
  if (!verdict) console.error(`      raw reply: ${(run.stdout ?? "").slice(0, 400) || "(empty)"}`);
  return verdict;
}

let failures = 0;
for (const testCase of cases) {
  const verdict = judge(testCase.timeline, testCase.turnedOff);
  const ok =
    verdict?.decision === testCase.expected.decision &&
    (testCase.expected.pattern === undefined || verdict.pattern === testCase.expected.pattern);
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${testCase.name}`);
  console.log(`      got ${verdict ? `${verdict.decision}/${verdict.pattern ?? "-"}: ${verdict.rationale}` : "no parseable verdict"}`);
}
console.log(`\n${cases.length - failures}/${cases.length} passed (${model})`);
process.exit(failures ? 1 : 0);
