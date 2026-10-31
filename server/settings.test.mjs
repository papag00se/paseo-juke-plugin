import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { setImmediate } from "node:timers/promises";

registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); }
  catch (error) {
    if (specifier.startsWith(".") && !/\.[a-z]+$/.test(specifier)) return next(`${specifier}.ts`, context);
    throw error;
  }
} });
const { default: contribute } = await import("../index.server.ts");
const { DefaultJudgePrompt, JudgePromptLimit } = await import("../shared/prompt.ts");
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const continueAs = pattern => ({ status: "idle", lastMessage: JSON.stringify({ decision: "continue", pattern, rationale: "Work remains", followUp: "Finish the requested work." }) });
const verdict = continueAs("announced-then-stopped");

function setup(t, { enabled = true, judgeValues = {}, preparation, judgement, result = verdict, timelineError, fullTimeline = [{ type: "user_message", text: "Finish the work." }], children = [], childTimelines = {}, listError } = {}) {
  const hooks = new Map(), created = [], sent = [], archived = [], registered = [];
  // Revisions are content-addressed, not monotonic: false → true restores the
  // original revision. Subscribers must still invalidate the old assessment.
  let state = { status: "ready", values: { enabled, judgeProvider: "", judgeModel: "", judgeThinkingOptionId: null, disabledJukes: [], ...judgeValues }, revision: String(enabled) };
  const listeners = new Set();
  t.mock.method(console, "log", () => {});
  const agent = { id: "original", workspaceId: "workspace", provider: "test", model: "test-model", labels: {} };
  const paseo = {
    agents: { list: async ({ filter }) => { if (listError) throw new Error("directory unavailable"); return { entries: children.filter(child => child.labels["paseo.parent-agent-id"] === filter.labels["paseo.parent-agent-id"]).map(agent => ({ agent })), pageInfo: { hasMore: false } }; }, ref: id => ({
      refresh: async () => { if (preparation) await preparation.promise; return { agent }; },
      timeline: { refetch: async () => {
        if (timelineError) throw new Error("history unavailable");
        const entries = id === "original" ? fullTimeline : childTimelines[id] ?? [];
        return { entries: entries.map(entry => "item" in entry ? entry : { item: entry }), hasOlder: false };
      } },
      send: async message => { sent.push({ id, message }); },
      archive: async () => { archived.push(id); },
    }) },
    workspaces: { ref: () => ({ agents: { create: async options => {
      created.push(options);
      return { id: "judge", waitForFinish: async () => judgement ? judgement.promise : result, send: async () => {} };
    } } }) },
  };
  const stop = contribute({
    registerSettings: definition => { registered.push(definition); return { read: async () => state, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); } }; },
    on: (name, handler) => { hooks.set(name, handler); return () => hooks.delete(name); },
  });
  t.after(stop);
  return { created, sent, archived, registered, stop,
    change(enabled) { state = { ...state, values: { ...state.values, enabled }, revision: String(enabled) }; for (const listener of listeners) listener(state); },
    changePrompt(judgePrompt) { state = { ...state, values: { ...state.values, judgePrompt }, revision: judgePrompt }; for (const listener of listeners) listener(state); },
    async fire() {
      hooks.get("agent.turn_ended")({ agent, outcome: { kind: "completed" }, timeline: [{ type: "user_message", text: "Finish the work." }], turnId: "turn" }, { paseo });
      await setImmediate();
    },
  };
}

test("native settings preserve automatic assessment by default; enabled runs still reuse the original model", async t => {
  const h = setup(t); await h.fire();
  assert.equal(h.registered[0].scope, "host");
  assert.deepEqual(h.registered[0].schema.parse({}), { enabled: true, judgePrompt: DefaultJudgePrompt, judgeProvider: "", judgeModel: "", judgeThinkingOptionId: null, disabledJukes: [] });
  assert.deepEqual(h.registered[0].schema.parse({ enabled: false }).enabled, false);
  assert.equal(h.created.length, 1);
  assert.equal(h.created[0].config.provider, "test/test-model");
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].message, /^\[Juke assessment\]/);
  assert.deepEqual(h.archived, ["judge"]);
});

test("saved prompt replaces default instructions, expands checks, and retains conversation evidence", async t => {
  const custom = 'Be strict. {{checks}} {{allowedNote}} Patterns: {{patterns}}';
  const h = setup(t, { judgeValues: { judgePrompt: custom, disabledJukes: ["paused-on-its-own"] } });
  await h.fire();
  const prompt = h.created[0].prompt;
  assert.match(prompt, /^Be strict\./);
  assert.match(prompt, /\d+\. announced-then-stopped:/);
  assert.match(prompt, /paused-on-its-own \(turned off\):/);
  assert.doesNotMatch(prompt, /\{\{(?:checks|allowedNote|patterns)\}\}/);
  assert.doesNotMatch(prompt, /You are Juke/);
  assert.match(prompt, /Conversation evidence:\n.*Finish the work\./);
  assert.equal(h.sent.length, 1);
  const schema = h.registered[0].schema;
  assert.equal(schema.parse({ judgePrompt: custom }).judgePrompt, custom);
  assert.equal(schema.safeParse({ judgePrompt: "   " }).success, false);
  assert.equal(schema.safeParse({ judgePrompt: "x".repeat(JudgePromptLimit + 1) }).success, false);
});

test("editing the prompt during assessment discards the old verdict and the next run uses the new prompt", async t => {
  const judgement = deferred(), h = setup(t, { judgement });
  await h.fire();
  h.changePrompt("New instructions");
  judgement.resolve(verdict); await setImmediate();
  assert.deepEqual(h.sent, []);
  await h.fire();
  assert.match(h.created[1].prompt, /^New instructions\n\nDetermine the user's overall goal/);
  assert.match(h.created[1].prompt, /Conversation evidence:/);
  assert.equal(h.sent.length, 1);
  h.changePrompt(DefaultJudgePrompt);
  await h.fire();
  assert.match(h.created[2].prompt, /^You are Juke/);
});

test("the judge receives older directions from full history, not only the hook's recent tail", async t => {
  const early = "Finish every ownership-plan item, not just the current task.";
  const h = setup(t, { fullTimeline: [{ type: "user_message", text: early }, { type: "user_message", text: "Finish the work." }] });
  await h.fire();
  assert.match(h.created[0].prompt, /Finish every ownership-plan item/);
  assert.match(h.created[0].prompt, /user-message labels still do not establish human authorship/);
  assert.match(h.created[0].prompt, /Do not assume a single blocked subtask completes or blocks the entire user goal/);
});

test("a child's prompt to the parent is labeled a subagent report; unmatched messages remain possible user direction", async t => {
  const report = 'Coordination notice received: I am child-1. I will not touch #647 or "Dependabot".';
  const h = setup(t, {
    fullTimeline: [
      { item: { type: "user_message", text: "Keep working through the ownership plan." }, timestamp: "2026-10-28T18:00:00.000Z" },
      { item: { type: "user_message", text: report.replace('"Dependabot"', '\\"Dependabot\\"').replace(". I will", ".\n  I will") }, timestamp: "2026-10-28T18:22:47.770Z" },
      { item: { type: "user_message", text: "Finish the work." }, timestamp: "2026-10-28T18:30:00.000Z" },
    ],
    children: [
      { id: "child-1", title: "Ownership worker", createdAt: "2026-10-28T18:20:38.000Z", updatedAt: "u1", labels: { "paseo.parent-agent-id": "original" } },
      { id: "judge-old", title: "Juke inference judge", createdAt: "2026-10-28T18:20:00.000Z", updatedAt: "u1", labels: { "paseo.parent-agent-id": "original", "juke-judge": "original" } },
    ],
    childTimelines: { "child-1": [
      // Rehydrated child timelines can restamp the send later than its delivery.
      { item: { type: "tool_call", callId: "c", name: "paseo.send_agent_prompt", status: "completed", error: null, detail: { type: "unknown", input: { tool: "paseo_send_agent_prompt", args: { agentId: "original", prompt: report, background: true } } } }, timestamp: "2026-10-31T16:31:46.399Z" },
    ] },
  });
  await h.fire();
  const evidence = JSON.parse(h.created[0].prompt.split("Conversation evidence:\n")[1]);
  const reports = evidence.items.filter(item => item.type === "subagent_report");
  assert.equal(reports.length, 1);
  assert.equal(reports[0].fromAgentId, "child-1");
  assert.deepEqual(evidence.items.filter(item => item.type === "user_message").map(item => item.text), ["Keep working through the ownership plan.", "Finish the work."]);
});

test("classification failure keeps every unmarked message as possible user direction", async t => {
  const errors = []; t.mock.method(console, "error", (...args) => errors.push(args));
  const h = setup(t, { listError: true, fullTimeline: [{ type: "user_message", text: "Report from a worker." }, { type: "user_message", text: "Finish the work." }] });
  await h.fire();
  assert.equal(h.created.length, 1);
  assert.match(h.created[0].prompt, /Report from a worker\./);
  assert.doesNotMatch(h.created[0].prompt.split("Conversation evidence:")[1], /subagent_report/);
  assert.ok(errors.some(args => String(args[0]).includes("subagent message classification failed")));
});

test("a history fetch failure is reported and does not judge a partial timeline", async t => {
  const errors = []; t.mock.method(console, "error", (...args) => errors.push(args));
  const h = setup(t, { timelineError: true }); await h.fire();
  assert.equal(h.created.length, 0);
  assert.ok(errors.some(args => String(args[0]).includes("inference judge failed") && String(args[1].error).includes("history unavailable")));
});

test("a configured judge provider, model and reasoning level replace the judged agent's model", async t => {
  const h = setup(t, { judgeValues: { judgeProvider: "pi", judgeModel: "judge-model", judgeThinkingOptionId: "high" } }); await h.fire();
  assert.equal(h.created[0].config.provider, "pi/judge-model");
  assert.equal(h.created[0].config.thinkingOptionId, "high");
});

test("a provider without a chosen model still reuses the judged agent's model", async t => {
  const h = setup(t, { judgeValues: { judgeProvider: "pi" } }); await h.fire();
  assert.equal(h.created[0].config.provider, "test/test-model");
  assert.equal(h.created[0].config.thinkingOptionId, undefined);
});

test("a turned-off juke is left out of the judge prompt and its continuation is not sent", async t => {
  const h = setup(t, { judgeValues: { disabledJukes: ["announced-then-stopped"] } }); await h.fire();
  assert.equal(h.created.length, 1);
  assert.doesNotMatch(h.created[0].prompt, /^\d+\. announced-then-stopped:/m);
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.archived, ["judge"]);
});

test("for every juke, turning it off alone blocks its continuation and keeps the others", async t => {
  const { JukeIds } = await import("../shared/jukes.ts");
  for (const id of JukeIds) {
    const off = setup(t, { judgeValues: { disabledJukes: [id] }, result: continueAs(id) }); await off.fire();
    assert.deepEqual(off.sent, [], `${id} continuation was sent while turned off`);
    off.stop();
    const other = JukeIds.find(candidate => candidate !== id);
    const on = setup(t, { judgeValues: { disabledJukes: [id] }, result: continueAs(other) }); await on.fire();
    assert.equal(on.sent.length, 1, `${other} continuation was blocked by turning off ${id}`);
    on.stop();
  }
});

test("a continuation for a juke that is still on is sent", async t => {
  const h = setup(t, { judgeValues: { disabledJukes: ["announced-then-stopped"] }, result: continueAs("paused-on-its-own") }); await h.fire();
  assert.equal(h.sent.length, 1);
});

test("with every juke turned off, no judge runs", async t => {
  const { JukeIds } = await import("../shared/jukes.ts");
  const h = setup(t, { judgeValues: { disabledJukes: [...JukeIds] } }); await h.fire();
  assert.deepEqual(h.created, []); assert.deepEqual(h.sent, []);
});

test("an unknown stored juke id does not invalidate the other settings", async t => {
  const h = setup(t);
  assert.deepEqual(h.registered[0].schema.parse({ enabled: false, disabledJukes: ["retired-juke"] }).enabled, false);
});

test("disabled assessments create no judges and send no follow-ups", async t => {
  const h = setup(t, { enabled: false }); await h.fire();
  assert.deepEqual(h.created, []); assert.deepEqual(h.sent, []);
  h.change(true); await h.fire();
  assert.equal(h.created.length, 1); assert.equal(h.sent.length, 1);
});

test("disabling during preparation prevents creation of a judge", async t => {
  const preparation = deferred(); const h = setup(t, { preparation });
  await h.fire(); h.change(false); preparation.resolve(); await setImmediate();
  assert.deepEqual(h.created, []); assert.deepEqual(h.sent, []);
});

for (const reenable of [false, true]) test(`changing settings during assessment discards the old verdict (re-enable: ${reenable})`, async t => {
  const judgement = deferred(), h = setup(t, { judgement });
  await h.fire(); assert.equal(h.created.length, 1);
  h.change(false); if (reenable) h.change(true);
  judgement.resolve(verdict); await setImmediate();
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.archived, ["judge"]);
});

test("plugin cleanup also suppresses pending follow-ups", async t => {
  const judgement = deferred(), h = setup(t, { judgement });
  await h.fire(); h.stop(); judgement.resolve(verdict); await setImmediate();
  assert.deepEqual(h.sent, []); assert.deepEqual(h.archived, ["judge"]);
});
