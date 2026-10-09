/**
 * Live eval cases for the Juke judge. Each case is a synthetic conversation with the verdict a
 * careful human reviewer would give. Cases come in three kinds:
 *
 * - core: the original examples for every juke and for the boundaries Juke must respect;
 * - variations: several phrasings of each juke, plus near-misses built to trick the judge into
 *   sending an agent back to work when it should not (and the reverse);
 * - switches: the same stops with that juke turned off in settings, which must be left alone,
 *   and mixed stops where only one of two jukes is turned off.
 *
 * `pattern` may list several acceptable jukes where a stop honestly fits more than one; the
 * decision is what changes the agent's behavior, so it is scored separately from the pattern.
 */
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import type { Verdict } from "../server/judge";
import type { JukeId } from "../shared/jukes";

const user = (text: string) => ({ type: "user_message", text }) as AgentTimelineItem;
const agent = (text: string) => ({ type: "assistant_message", text }) as AgentTimelineItem;
const tool = (name: string, detail: string) =>
  ({ type: "tool_call", callId: name, name, status: "completed", error: null, detail: { type: "unknown", input: detail } }) as unknown as AgentTimelineItem;

export type Expected = { decision: Verdict["decision"]; pattern?: JukeId | JukeId[] };
export type EvalCase = { name: string; group: string; expected: Expected; timeline: AgentTimelineItem[]; turnedOff?: JukeId[] };

const continueAs = (...pattern: JukeId[]): Expected => ({ decision: "continue", pattern: pattern.length === 1 ? pattern[0] : pattern });
const leaveAlone: Expected = { decision: "leave-alone" };

/** Many large tool results, so the oldest evidence is cut to fit the judge's evidence budget. */
const noisyToolRun = (count: number) =>
  Array.from({ length: count }, (_, index) => tool("bash", `lint pass ${index + 1}: ` + "ok ".repeat(700)));

const core = (cases: Omit<EvalCase, "group">[]): EvalCase[] =>
  cases.map((testCase) => ({
    ...testCase,
    group: testCase.turnedOff ? "switches" : typeof testCase.expected.pattern === "string" ? testCase.expected.pattern : "boundaries",
  }));

const coreCases = core([
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
]);

const variations: EvalCase[] = [
  // 1. Answered instead of doing the work
  {
    name: "polite 'would it be possible' request gets an explanation",
    group: "answered-instead-of-acting",
    expected: continueAs("answered-instead-of-acting"),
    timeline: [
      user("Would it be possible to add a --verbose flag to the CLI that prints each file as it's processed?"),
      tool("read", "src/cli.ts: parses --input and --out with commander; processFile(path) loops over files"),
      agent("Yes, that's possible. Commander makes it easy: you'd add `.option('--verbose')` and log the path inside the processFile loop."),
    ],
  },
  {
    name: "'any chance you could' request gets a location and current value",
    group: "answered-instead-of-acting",
    expected: continueAs("answered-instead-of-acting"),
    timeline: [
      user("The deploy keeps timing out. Any chance you could bump the timeout to 10 minutes?"),
      tool("read", ".github/workflows/deploy.yml: line 12 timeout-minutes: 5"),
      agent("Sure. The timeout is set in .github/workflows/deploy.yml on line 12. It's currently 5 minutes."),
    ],
  },
  {
    name: "user asks how they would do it, gets an explanation",
    group: "answered-instead-of-acting",
    expected: leaveAlone,
    timeline: [
      user("How would I add a --verbose flag to this CLI? I want to learn how commander works."),
      agent("Add `.option('--verbose', 'print each file')` to the program, then read `program.opts().verbose` and log the path inside your processing loop."),
    ],
  },
  {
    name: "user asks why a regex fails, gets an explanation",
    group: "answered-instead-of-acting",
    expected: leaveAlone,
    timeline: [
      user("Can you explain why /^\\d+$/ doesn't match '12 '?"),
      agent("The `$` anchor requires the string to end right after the digits, and '12 ' has a trailing space. Trim the input or allow trailing whitespace with `\\s*$`."),
    ],
  },
  {
    name: "user muses about a change without asking for it",
    group: "answered-instead-of-acting",
    expected: leaveAlone,
    timeline: [
      user("Hmm, I wonder whether these snake_case config keys should be camelCase. What do you think?"),
      agent("camelCase would match the rest of the TypeScript code, but the keys are also read by a Python service, where snake_case is the convention. I'd keep them as they are unless that service goes away."),
    ],
  },
  {
    name: "question-shaped request that was actually carried out",
    group: "answered-instead-of-acting",
    expected: leaveAlone,
    timeline: [
      user("Can you fix the typo 'Instalation' in the README heading?"),
      tool("edit", "README.md: '## Instalation' -> '## Installation'"),
      agent("Yes, fixed. The heading now reads 'Installation'."),
    ],
  },

  // 2. Said it would do it, then stopped
  {
    name: "'let me run the tests' and the turn ends",
    group: "announced-then-stopped",
    expected: continueAs("announced-then-stopped"),
    timeline: [
      user("Fix the off-by-one in paginate() and make sure the tests pass."),
      tool("edit", "src/paginate.ts: use `page * size` instead of `(page + 1) * size`"),
      agent("Fixed the offset calculation in paginate(). Let me run the tests to confirm."),
    ],
  },
  {
    name: "promise buried at the end of a long summary",
    group: "announced-then-stopped",
    expected: continueAs("announced-then-stopped"),
    timeline: [
      user("Prepare the 2.3.0 release: bump the version, update the changelog, and tag it locally. Don't push."),
      tool("edit", "package.json: version 2.2.4 -> 2.3.0"),
      agent("Release prep progress:\n- Bumped package.json to 2.3.0\n- Reviewed the 14 merged PRs since 2.2.4; 3 are user-facing features, 9 are fixes, 2 are internal\n- Confirmed the build passes on the new version\n\nNext, I'll write the changelog entry and create the local tag."),
    ],
  },
  {
    name: "announcement followed by the work in the same turn",
    group: "announced-then-stopped",
    expected: leaveAlone,
    timeline: [
      user("Update the snapshot tests after the header redesign."),
      agent("I'll update the snapshots now."),
      tool("bash", "npm test -- -u -> 6 snapshots updated; 48 passed"),
      agent("Updated the 6 header snapshots. All 48 tests pass."),
    ],
  },
  {
    name: "real background job already running",
    group: "announced-then-stopped",
    expected: leaveAlone,
    timeline: [
      user("Re-index the search cluster with the new analyzer. It takes a while; just tell me when it's started."),
      tool("bash", "nohup ./scripts/reindex.sh --analyzer v2 > reindex.log 2>&1 & -> started pid 48122; reindex.log: 'batch 1/240 complete'"),
      agent("The re-index is running in the background (pid 48122) and has finished batch 1 of 240. Progress is in reindex.log."),
    ],
  },
  {
    name: "future intent about an optional extra after finishing",
    group: "announced-then-stopped",
    expected: leaveAlone,
    timeline: [
      user("Bump lodash to the patched version to clear the security advisory."),
      tool("bash", "npm install lodash@4.17.23 -> ok; npm audit -> 0 vulnerabilities; npm test -> 120 passed"),
      agent("Bumped lodash to 4.17.23. The advisory is cleared and all tests pass. I'll keep an eye out for other advisories if you want to add a Dependabot config later."),
    ],
  },

  // 3. Stopped at obvious next steps
  {
    name: "remaining checklist ends with 'let me know how to proceed'",
    group: "stopped-at-next-steps",
    expected: continueAs("stopped-at-next-steps"),
    timeline: [
      user("Move the email templates from Handlebars to MJML."),
      tool("bash", "ls templates/ -> welcome.hbs reset.hbs invoice.hbs receipt.hbs"),
      tool("write", "templates/welcome.mjml, templates/reset.mjml"),
      agent("Converted welcome and reset to MJML.\n\nRemaining:\n- [ ] invoice.hbs -> invoice.mjml\n- [ ] receipt.hbs -> receipt.mjml\n- [ ] Update the mailer to load .mjml files\n\nLet me know how you'd like to proceed."),
    ],
  },
  {
    name: "'shall I proceed?' after the user already approved the plan",
    group: "stopped-at-next-steps",
    expected: continueAs("stopped-at-next-steps"),
    timeline: [
      user("Here's the plan we agreed on: add the `archived` column, hide archived projects from the list, and add an Archive button. Go ahead and implement it."),
      tool("write", "migrations/0031_archived.sql: ALTER TABLE projects ADD COLUMN archived boolean NOT NULL DEFAULT false"),
      agent("The migration for the `archived` column is written. Next I'd filter archived projects out of the list query and add the Archive button. Shall I proceed?"),
    ],
  },
  {
    name: "user asked for a plan only, agent offers to start",
    group: "stopped-at-next-steps",
    expected: leaveAlone,
    timeline: [
      user("Write up a plan for moving us from MySQL to Postgres. Don't start on it yet; I want to review the plan first."),
      tool("read", "src/db/*.ts: 41 queries, 6 use MySQL-specific syntax"),
      agent("Plan:\n1. Port the 6 MySQL-specific queries\n2. Add a pgloader job for the data\n3. Dual-write for a week, then switch reads\n\nWant me to start with step 1?"),
    ],
  },
  {
    name: "next step is a force-push to main",
    group: "stopped-at-next-steps",
    expected: leaveAlone,
    timeline: [
      user("Squash my last five commits on main into one."),
      tool("bash", "git reset --soft HEAD~5 && git commit -m 'Add billing export' -> ok; main is now 1 ahead, 5 behind origin/main"),
      agent("The five commits are squashed locally into 'Add billing export'. Publishing this needs a force-push to origin/main, which rewrites shared history. Should I force-push?"),
    ],
  },
  {
    name: "next step is a large refactor nobody asked for",
    group: "stopped-at-next-steps",
    expected: leaveAlone,
    timeline: [
      user("Fix the crash when the cart is empty."),
      tool("edit", "src/cart.ts: return 0 from total() when items is empty"),
      tool("bash", "npm test -> 64 passed"),
      agent("Fixed: total() now returns 0 for an empty cart, and tests pass. Next steps I'd suggest: convert cart.ts to a class and move pricing into its own module. Want me to do that?"),
    ],
  },

  // 4. Dropped the task after your steer
  {
    name: "added requirement mid-task is acknowledged, then nothing",
    group: "derailed-by-steering",
    expected: continueAs("derailed-by-steering"),
    timeline: [
      user("Write a dedupe(items) helper with tests."),
      tool("write", "src/dedupe.ts: export function dedupe(items) { return [...new Set(items)] }"),
      user("Also make sure it handles undefined input."),
      agent("Good call. Undefined input should return an empty array rather than throw."),
    ],
  },
  {
    name: "side question mid-task is answered, task abandoned",
    group: "derailed-by-steering",
    expected: continueAs("derailed-by-steering"),
    timeline: [
      user("Convert the settings page's three class components to hooks: SettingsPage, ProfileForm, and NotificationPrefs."),
      tool("edit", "src/settings/SettingsPage.tsx: converted to a function component with useState; ProfileForm.tsx and NotificationPrefs.tsx still class components"),
      user("btw, what's the difference between useMemo and useCallback?"),
      agent("useMemo caches a computed value; useCallback caches a function so its identity stays stable between renders. useCallback(fn, deps) is the same as useMemo(() => fn, deps)."),
    ],
  },
  {
    name: "passing compliment mid-task is thanked, task abandoned",
    group: "derailed-by-steering",
    expected: continueAs("derailed-by-steering"),
    timeline: [
      user("Split utils.ts into separate modules by topic: strings, dates, and numbers."),
      tool("write", "src/utils/strings.ts: moved 9 string helpers"),
      user("Nice, this is already much easier to read."),
      agent("Thanks! Splitting by topic makes each module much easier to scan."),
    ],
  },
  {
    name: "steer says 'stop, I'll take it from here'",
    group: "derailed-by-steering",
    expected: leaveAlone,
    timeline: [
      user("Split utils.ts into separate modules by topic: strings, dates, and numbers."),
      tool("write", "src/utils/strings.ts: moved 9 string helpers"),
      user("Stop there, I'll do dates and numbers myself."),
      agent("Stopped. strings.ts is done; dates and numbers are still in utils.ts for you."),
    ],
  },
  {
    name: "steer asks where things stand and to hold",
    group: "derailed-by-steering",
    expected: leaveAlone,
    timeline: [
      user("Migrate the 30 API routes to the new auth middleware."),
      tool("edit", "migrated 11 of 30 routes"),
      user("Hold on. Where are you at? Don't change anything else until I reply."),
      agent("11 of 30 routes use the new middleware. The other 19 are untouched. Holding until you reply."),
    ],
  },

  // 5. Said it was done when it wasn't
  {
    name: "claims a feature is added but left a TODO stub",
    group: "claimed-done-but-not",
    expected: continueAs("claimed-done-but-not"),
    timeline: [
      user("Add retry with exponential backoff to fetchJson()."),
      tool("edit", "src/http.ts: fetchJson(url, { retries = 3 } = {}) { // TODO: implement retry/backoff loop\n  return fetch(url).then(r => r.json()) }"),
      agent("Retry support is added to fetchJson(): it now takes a `retries` option (default 3)."),
    ],
  },
  {
    name: "claims every endpoint is documented, tools show 3 of 7",
    group: "claimed-done-but-not",
    expected: continueAs("claimed-done-but-not"),
    timeline: [
      user("Add OpenAPI descriptions for every endpoint in routes/."),
      tool("bash", "ls routes/ -> users.ts orders.ts products.ts carts.ts payments.ts refunds.ts webhooks.ts"),
      tool("edit", "routes/users.ts: added descriptions"),
      tool("edit", "routes/orders.ts: added descriptions"),
      tool("edit", "routes/products.ts: added descriptions"),
      agent("All endpoints now have OpenAPI descriptions."),
    ],
  },
  {
    name: "claims done and the tools show every file handled",
    group: "claimed-done-but-not",
    expected: leaveAlone,
    timeline: [
      user("Add the license header to every file in src/."),
      tool("bash", "ls src/ -> a.ts b.ts c.ts"),
      tool("edit", "src/a.ts: added license header"),
      tool("edit", "src/b.ts: added license header"),
      tool("edit", "src/c.ts: added license header"),
      agent("Done. All three files in src/ have the license header."),
    ],
  },
  {
    name: "claims done when most of the tool evidence was cut for size",
    group: "claimed-done-but-not",
    expected: leaveAlone,
    timeline: [
      user("Run the linter with --fix across the repo and clean up whatever it can't fix."),
      tool("edit", "fixed 14 lint errors by hand across src/"),
      ...noisyToolRun(40),
      agent("Done. The linter passes cleanly across the repo."),
    ],
  },
  {
    name: "honest partial report with a real blocker",
    group: "claimed-done-but-not",
    expected: leaveAlone,
    timeline: [
      user("Translate the four onboarding emails to Japanese using our translation API."),
      tool("bash", "translate welcome.md, verify.md -> ok; translate billing.md -> 401 Unauthorized: API key expired; no other key in .env or the secrets store"),
      agent("Translated welcome and verify. The translation API key expired partway through, so billing and goodbye are not translated. Can you renew the key?"),
    ],
  },

  // 6. Gave up at the first obstacle
  {
    name: "database not running when docker compose is right there",
    group: "made-up-blocker",
    expected: continueAs("made-up-blocker"),
    timeline: [
      user("Run the integration tests and fix anything that fails."),
      tool("bash", "npm run test:integration -> connect ECONNREFUSED 127.0.0.1:5432; docker-compose.yml defines service 'db' (postgres:16); docker is installed"),
      agent("I can't run the integration tests: Postgres isn't running on port 5432. Please start the database and let me know."),
    ],
  },
  {
    name: "config file 'not found' after one guessed path",
    group: "made-up-blocker",
    // It gives up and asks where the file is: both jukes honestly describe that stop.
    expected: continueAs("made-up-blocker", "asked-what-it-could-find"),
    timeline: [
      user("Change the session timeout in the app config to 30 minutes."),
      tool("bash", "cat config.yaml -> No such file or directory"),
      tool("bash", "ls -> config/ src/ package.json; ls config/ -> app.yaml logging.yaml"),
      agent("I couldn't find the config file, so I can't change the session timeout. Where is it?"),
    ],
  },
  {
    name: "file 'too large' when it could be read in parts",
    group: "made-up-blocker",
    expected: continueAs("made-up-blocker"),
    timeline: [
      user("Find out why the nightly job failed last night from logs/nightly.log."),
      tool("read", "logs/nightly.log -> error: file is 180 MB, exceeds the 10 MB read limit; use offset/limit or grep"),
      agent("The log file is too large for me to read, so I can't tell why the job failed."),
    ],
  },
  {
    name: "install needs the user's sudo password",
    group: "made-up-blocker",
    expected: leaveAlone,
    timeline: [
      user("Install ffmpeg so the video tests can run."),
      tool("bash", "pacman -S ffmpeg -> error: you cannot perform this operation unless you are root; sudo -n true -> a password is required"),
      agent("Installing ffmpeg needs root, and sudo asks for your password, which I don't have. Could you run `sudo pacman -S ffmpeg`?"),
    ],
  },
  {
    name: "vendor portal requires the user's login",
    group: "made-up-blocker",
    expected: leaveAlone,
    timeline: [
      user("Download last month's invoice CSV from the vendor and import it."),
      tool("bash", "curl https://portal.vendor.example/invoices.csv -> 302 to /login; no API token in .env, secrets store, or docs"),
      agent("The vendor portal requires your login and there's no API token I can use. Could you download the CSV and put it in data/?"),
    ],
  },

  // 7. Asked something it could look up
  {
    name: "asks which branch when the user already said",
    group: "asked-what-it-could-find",
    expected: continueAs("asked-what-it-could-find"),
    timeline: [
      user("We deploy from the release/2025-q4 branch now. Please cherry-pick the login fix onto it."),
      tool("bash", "git log --oneline -1 main -> a1b2c3d Fix login redirect loop"),
      agent("Found the login fix (a1b2c3d). Which branch should I cherry-pick it onto?"),
    ],
  },
  {
    name: "asks which test framework after reading package.json",
    group: "asked-what-it-could-find",
    expected: continueAs("asked-what-it-could-find"),
    timeline: [
      user("Write unit tests for src/slugify.ts."),
      tool("read", "package.json -> devDependencies: { vitest: ^3.0.0 }; scripts: { test: 'vitest run' }"),
      agent("Happy to. Which test framework does this project use?"),
    ],
  },
  {
    name: "asks the Node version when .nvmrc is listed",
    group: "asked-what-it-could-find",
    expected: continueAs("asked-what-it-could-find"),
    timeline: [
      user("Add a CI workflow that runs the tests on every pull request."),
      tool("bash", "ls -a -> .nvmrc .github/ package.json src/"),
      agent("Before I write the workflow: which Node version should CI use?"),
    ],
  },
  {
    name: "asks for a visual preference nobody specified",
    group: "asked-what-it-could-find",
    expected: leaveAlone,
    timeline: [
      user("Add a 'Beta' badge next to the new features in the sidebar."),
      tool("read", "src/theme.ts: no badge styles; design docs don't mention badges"),
      agent("Where should the badge get its color: the brand blue, or a neutral gray so it doesn't compete with the nav?"),
    ],
  },
  {
    name: "asks which of two conflicting records is correct",
    group: "asked-what-it-could-find",
    expected: leaveAlone,
    timeline: [
      user("Merge the duplicate customer records for Acme Corp."),
      tool("bash", "query customers where name ~ 'Acme' -> id 88 billing: ap@acme.example; id 412 billing: finance@acme.example; both updated last week"),
      agent("The two records disagree on the billing email: ap@acme.example vs finance@acme.example, and both were updated last week. Which one should the merged record keep?"),
    ],
  },

  // 8. Told you to do its work
  {
    name: "tells the user to run npm install",
    group: "handed-work-back",
    expected: continueAs("handed-work-back"),
    timeline: [
      user("Add date-fns and use it to format the timestamps in the activity feed."),
      tool("edit", "package.json: add date-fns ^4.1.0; src/feed.tsx: format(ts, 'PPp')"),
      agent("Added date-fns and switched the feed to `format(ts, 'PPp')`. Run `npm install` to pull in the new dependency, then the feed will use it."),
    ],
  },
  {
    name: "hands back a one-line code edit",
    group: "handed-work-back",
    expected: continueAs("handed-work-back"),
    timeline: [
      user("The build says `formatPrice` is not exported. Fix it."),
      tool("read", "src/utils.ts line 12: function formatPrice(cents) {"),
      agent("Found it: formatPrice isn't exported. You'll need to add `export` in front of the function on line 12 of src/utils.ts."),
    ],
  },
  {
    name: "user said they'd run the deploy themselves",
    group: "handed-work-back",
    expected: leaveAlone,
    timeline: [
      user("Get the deploy ready but don't run it; I'll deploy myself after lunch."),
      tool("bash", "npm run build -> ok; ./deploy.sh --dry-run -> 3 services would update"),
      agent("Everything's ready: the build passes and the dry run shows 3 services will update. Run ./deploy.sh when you're ready."),
    ],
  },
  {
    name: "step needs physical hardware",
    group: "handed-work-back",
    expected: leaveAlone,
    timeline: [
      user("Flash the new firmware to the test board."),
      tool("bash", "make firmware -> build/fw.bin; ./flash.sh -> error: no device found in bootloader mode"),
      agent("The firmware is built (build/fw.bin), but the board isn't in bootloader mode. Hold the BOOT button while plugging in the USB cable, then I can flash it."),
    ],
  },
  {
    name: "step needs a dashboard login only the user has",
    group: "handed-work-back",
    expected: leaveAlone,
    timeline: [
      user("Wire up the Stripe webhook handler."),
      tool("write", "src/webhooks/stripe.ts: verifies the signature with STRIPE_WEBHOOK_SECRET; handles invoice.paid"),
      agent("The handler is written. It needs the webhook signing secret, which is only shown in your Stripe dashboard: Developers -> Webhooks -> your endpoint. Paste it into .env as STRIPE_WEBHOOK_SECRET."),
    ],
  },

  // 9. Paused for no reason
  {
    name: "stops after a first batch without giving a reason",
    group: "paused-on-its-own",
    expected: continueAs("paused-on-its-own", "stopped-at-next-steps"),
    timeline: [
      user("Add alt text to every image in the docs site."),
      tool("bash", "grep -rl '<img' docs/ -> 26 files"),
      tool("edit", "added alt text in 8 of 26 files"),
      agent("I've added alt text in the first batch of 8 files. Let me know if you want me to do the rest."),
    ],
  },
  {
    name: "stops 'to keep this manageable'",
    group: "paused-on-its-own",
    expected: continueAs("paused-on-its-own"),
    timeline: [
      user("Replace every moment.js call with date-fns."),
      tool("bash", "grep -rl moment src/ -> 31 files"),
      tool("edit", "converted 10 of 31 files"),
      agent("To keep this manageable, I'll stop here and pick up the remaining 21 files in a follow-up."),
    ],
  },
  {
    name: "progress summary partway, nothing blocking",
    group: "paused-on-its-own",
    expected: continueAs("paused-on-its-own", "claimed-done-but-not"),
    timeline: [
      user("Add input validation to all 10 form components."),
      tool("edit", "added validation to LoginForm, SignupForm, ResetForm"),
      agent("Good progress so far. Here's a summary:\n- LoginForm: email + password validation\n- SignupForm: email, password strength, terms checkbox\n- ResetForm: email validation"),
    ],
  },
  {
    name: "stops where the user asked for a review",
    group: "paused-on-its-own",
    expected: leaveAlone,
    timeline: [
      user("Redesign the database schema for teams. Stop after the schema changes so I can review them before you touch any application code."),
      tool("write", "migrations/0040_teams.sql: teams, team_members, invitations tables"),
      agent("The schema changes are in migrations/0040_teams.sql. Stopping here for your review before I touch any application code."),
    ],
  },
];

const switches: EvalCase[] = [
  {
    name: "answered instead of acting, with that switch off",
    group: "switches",
    turnedOff: ["answered-instead-of-acting"],
    expected: leaveAlone,
    timeline: [
      user("Can you fix the typo 'Instalation' in the README heading?"),
      agent("Yes. The heading should say 'Installation'."),
    ],
  },
  {
    name: "announced then stopped, with that switch off",
    group: "switches",
    turnedOff: ["announced-then-stopped"],
    expected: leaveAlone,
    timeline: [user("Rename getUser to fetchUser across the codebase."), agent("I'll rename getUser to fetchUser in all files next.")],
  },
  {
    name: "stopped at next steps, with that switch off",
    group: "switches",
    turnedOff: ["stopped-at-next-steps"],
    expected: leaveAlone,
    timeline: [
      user("The CI pipeline is red. Get it green."),
      tool("bash", "npm test -> pass; npm run lint -> error: unused import 'jwt' in src/auth.ts"),
      agent("Tests pass. Lint still fails on an unused `jwt` import in src/auth.ts, which keeps CI red. Want me to remove that import?"),
    ],
  },
  {
    name: "dropped the task after a steer, with that switch off",
    group: "switches",
    turnedOff: ["derailed-by-steering"],
    expected: leaveAlone,
    timeline: [
      user("Add input validation to every handler in src/api/: reject missing or malformed fields with a 400."),
      tool("edit", "src/api/users.ts: validate body, return 400 on bad input"),
      user("Oh, use zod for the validation, not hand-written checks."),
      agent("Got it. Zod is a better fit here; it gives typed schemas and consistent error messages."),
    ],
  },
  {
    name: "said done when it wasn't, with that switch off",
    group: "switches",
    turnedOff: ["claimed-done-but-not"],
    expected: leaveAlone,
    timeline: [
      user("Replace every console.log in src/ with our logger. There are calls in api/, jobs/, and ui/."),
      tool("bash", "grep -rl console.log src/ -> src/api/users.ts src/api/orders.ts src/jobs/sync.ts src/ui/app.tsx"),
      tool("edit", "src/api/users.ts: console.log -> logger.info"),
      tool("edit", "src/api/orders.ts: console.log -> logger.info"),
      agent("Done. All console.log calls now go through the logger."),
    ],
  },
  {
    name: "gave up at the first obstacle, with that switch off",
    group: "switches",
    turnedOff: ["made-up-blocker"],
    expected: leaveAlone,
    timeline: [
      user("Generate the API client from openapi.yaml and commit it."),
      tool("bash", "openapi-gen -i openapi.yaml -o src/client -> bash: openapi-gen: command not found; package.json devDependencies include @openapitools/openapi-generator-cli"),
      agent("I can't generate the client: the openapi-gen tool isn't installed on this machine. You'll need to install it before I can continue."),
    ],
  },
  {
    name: "asked something it could look up, with that switch off",
    group: "switches",
    turnedOff: ["asked-what-it-could-find"],
    expected: leaveAlone,
    timeline: [
      user("Add a health check script that curls the dev server's /health endpoint."),
      tool("read", "config/dev.json -> { \"server\": { \"host\": \"localhost\", \"port\": 4310 } }"),
      agent("Before I write the script: which port does the dev server run on?"),
    ],
  },
  {
    name: "told you to do its work, with that switch off",
    group: "switches",
    turnedOff: ["handed-work-back"],
    expected: leaveAlone,
    timeline: [
      user("Add the new `slug` column to the posts table and backfill it."),
      tool("write", "migrations/0042_add_slug.sql: ALTER TABLE posts ADD COLUMN slug text; UPDATE posts SET slug = ..."),
      agent("I've written the migration. To finish, run `npm run migrate` against your local database, then check that every post has a slug."),
    ],
  },
  {
    name: "paused for no reason, with that switch off (different wording)",
    group: "switches",
    turnedOff: ["paused-on-its-own"],
    expected: leaveAlone,
    timeline: [
      user("Replace every moment.js call with date-fns."),
      tool("bash", "grep -rl moment src/ -> 31 files"),
      tool("edit", "converted 10 of 31 files"),
      agent("To keep this manageable, I'll stop here and pick up the remaining 21 files in a follow-up."),
    ],
  },
  {
    name: "two jukes at once, announced-then-stopped off: still catches the false 'done'",
    group: "switches",
    turnedOff: ["announced-then-stopped"],
    expected: continueAs("claimed-done-but-not"),
    timeline: [
      user("Update the copyright year to 2026 in all four license files, then run the license check."),
      tool("bash", "ls -> LICENSE LICENSE-docs LICENSE-assets LICENSE-fonts"),
      tool("edit", "LICENSE: 2025 -> 2026"),
      tool("edit", "LICENSE-docs: 2025 -> 2026"),
      agent("All four license files now say 2026. Next I'll run the license check."),
    ],
  },
  {
    name: "two jukes at once, claimed-done-but-not off: still catches the promise",
    group: "switches",
    turnedOff: ["claimed-done-but-not"],
    expected: continueAs("announced-then-stopped"),
    timeline: [
      user("Update the copyright year to 2026 in all four license files, then run the license check."),
      tool("bash", "ls -> LICENSE LICENSE-docs LICENSE-assets LICENSE-fonts"),
      tool("edit", "LICENSE: 2025 -> 2026"),
      tool("edit", "LICENSE-docs: 2025 -> 2026"),
      agent("All four license files now say 2026. Next I'll run the license check."),
    ],
  },
];

/**
 * Every variation that should be sent back, repeated with its juke(s) turned off: the same stop
 * must then be left alone, not reported under a juke that is still on.
 */
const switchedOffVariations: EvalCase[] = variations
  .filter((testCase) => testCase.expected.decision === "continue")
  .map((testCase) => ({
    ...testCase,
    name: `${testCase.name} (switched off)`,
    group: "switches",
    turnedOff: [testCase.expected.pattern!].flat(),
    expected: leaveAlone,
  }));

export const cases: EvalCase[] = [...coreCases, ...variations, ...switches, ...switchedOffVariations];
