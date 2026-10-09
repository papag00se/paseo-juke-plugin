/**
 * Live behavioral eval of the judge prompt against a real model. Unlike `npm test`, this costs
 * inference, so run it when the prompt or a juke's rule changes:
 *
 *   npm run eval                                   # every case once, default model
 *   npm run eval -- --repeat 3                     # each case three times, to expose flaky verdicts
 *   npm run eval -- --only steer                   # cases whose name or group contains "steer"
 *   npm run eval -- --model openai/gpt-5.4         # a different judge model
 *   npm run eval -- --report eval/RESULTS.md       # also write a markdown report
 *
 * Cases live in eval/cases.ts.
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { judgePrompt, parseVerdict, type Verdict } from "../server/judge";
import { JukeIds } from "../shared/jukes";
import { cases, type EvalCase } from "./cases";

const DefaultModel = "anthropic/claude-opus-5-5";
const JudgeTimeoutMs = 180_000;

const { values: options } = parseArgs({
  options: {
    model: { type: "string", default: DefaultModel },
    only: { type: "string" },
    repeat: { type: "string", default: "1" },
    concurrency: { type: "string", default: "4" },
    report: { type: "string" },
  },
});
const model = options.model!;
const repeat = Math.max(1, Number(options.repeat));
const concurrency = Math.max(1, Number(options.concurrency));
const selected = options.only ? cases.filter((c) => c.name.includes(options.only!) || c.group.includes(options.only!)) : cases;

type Run = { verdict: Verdict | null; raw: string };
type Outcome = { testCase: EvalCase; runs: Run[] };

function judge(testCase: EvalCase): Promise<Run> {
  const enabled = JukeIds.filter((id) => !testCase.turnedOff?.includes(id));
  return new Promise((resolve) => {
    const child = spawn("pi", ["-p", "--no-session", "--no-tools", "--model", model, judgePrompt(testCase.timeline, enabled)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill("SIGTERM"), JudgeTimeoutMs);
    child.on("close", () => {
      clearTimeout(timer);
      resolve({ verdict: parseVerdict(stdout), raw: (stdout || stderr).trim().slice(0, 400) || "(empty)" });
    });
  });
}

const decisionOk = (c: EvalCase, run: Run) => [c.expected].flat().some((expected) => run.verdict?.decision === expected.decision);
const patternOk = (c: EvalCase, run: Run) =>
  [c.expected].flat().some(
    (expected) =>
      run.verdict?.decision === expected.decision &&
      (expected.decision !== "continue" || expected.pattern === undefined || [expected.pattern].flat().includes(run.verdict.pattern!)),
  );
const describeExpected = (c: EvalCase) =>
  [c.expected]
    .flat()
    .map((expected) => `${expected.decision}${expected.pattern ? `/${[expected.pattern].flat().join(" or ")}` : ""}`)
    .join(" or ");
const describe = (run: Run) => (run.verdict ? `${run.verdict.decision}/${run.verdict.pattern ?? "-"}` : "unreadable");

async function main() {
  // Each (case, attempt) pair is one job; a fixed pool of workers drains the queue.
  const jobs = selected.flatMap((testCase) => Array.from({ length: repeat }, () => testCase));
  const results = new Map<EvalCase, Run[]>(selected.map((c) => [c, []]));
  let next = 0;
  let finished = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
      while (next < jobs.length) {
        const testCase = jobs[next++];
        const run = await judge(testCase);
        results.get(testCase)!.push(run);
        finished += 1;
        const mark = patternOk(testCase, run) ? "PASS" : decisionOk(testCase, run) ? "LABEL" : "FAIL";
        console.log(`[${finished}/${jobs.length}] ${mark}  ${testCase.name}  -> ${describe(run)}`);
        if (mark !== "PASS") console.log(`      ${run.verdict?.rationale ?? run.raw}`);
      }
    }),
  );

  const outcomes: Outcome[] = selected.map((testCase) => ({ testCase, runs: results.get(testCase)! }));
  const total = jobs.length;
  const decisionPasses = outcomes.reduce((sum, o) => sum + o.runs.filter((r) => decisionOk(o.testCase, r)).length, 0);
  const labelPasses = outcomes.reduce((sum, o) => sum + o.runs.filter((r) => patternOk(o.testCase, r)).length, 0);
  const unreadable = outcomes.reduce((sum, o) => sum + o.runs.filter((r) => !r.verdict).length, 0);

  const groups = [...new Set(selected.map((c) => c.group))];
  const lines = [
    `# Juke judge eval results`,
    ``,
    `- Model: \`${model}\``,
    `- Cases: ${selected.length}, each run ${repeat} time(s): ${total} verdicts`,
    `- Right decision: ${decisionPasses}/${total}`,
    `- Right decision and right juke: ${labelPasses}/${total}`,
    `- Unreadable replies: ${unreadable}`,
    ``,
    `| Group | Right decision | Right decision and juke |`,
    `| --- | --- | --- |`,
    ...groups.map((group) => {
      const inGroup = outcomes.filter((o) => o.testCase.group === group);
      const runs = inGroup.flatMap((o) => o.runs.map((r) => [o.testCase, r] as const));
      return `| ${group} | ${runs.filter(([c, r]) => decisionOk(c, r)).length}/${runs.length} | ${runs.filter(([c, r]) => patternOk(c, r)).length}/${runs.length} |`;
    }),
    ``,
    `## Misses`,
    ``,
    ...outcomes
      .filter((o) => o.runs.some((r) => !patternOk(o.testCase, r)))
      .flatMap((o) => {
        return [
          `- **${o.testCase.name}** (${o.testCase.group}): expected ${describeExpected(o.testCase)}; got ${o.runs.map(describe).join(", ")}`,
          ...o.runs.filter((r) => !patternOk(o.testCase, r)).map((r) => `  - ${(r.verdict?.rationale ?? r.raw).replace(/\s+/g, " ")}`),
        ];
      }),
  ];
  const report = lines.join("\n") + "\n";
  console.log("\n" + report);
  if (options.report) writeFileSync(options.report, report);
  process.exit(decisionPasses === total ? 0 : 1);
}

void main();
