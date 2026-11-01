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

function setup(t, { enabled = true, judgeValues = {}, preparation, judgement, result = verdict, timelineError, fullTimeline = [{ type: "user_message", text: "Finish the work." }] } = {}) {
  const hooks = new Map(), handlers = new Map(), created = [], sent = [], archived = [], registered = [], rows = [];
  // Revisions are content-addressed, not monotonic: false → true restores the
  // original revision. Subscribers must still invalidate the old assessment.
  // These assessment tests send at once; the countdown has its own tests below.
  let state = { status: "ready", values: { enabled, judgeProvider: "", judgeModel: "", judgeThinkingOptionId: null, disabledJukes: [], nudgeDelaySeconds: 0, pauseAutoResume: true, pauseAutoResumeMinutes: 5, ...judgeValues }, revision: String(enabled) };
  const listeners = new Set();
  t.mock.method(console, "log", () => {});
  const agent = { id: "original", workspaceId: "workspace", provider: "test", model: "test-model", labels: {} };
  const paseo = {
    agents: { ref: id => ({
      refresh: async () => { if (preparation) await preparation.promise; return { agent }; },
      send: async message => { sent.push({ id, message }); },
      timeline: { refetch: async () => { if (timelineError) throw new Error("history unavailable"); return { entries: fullTimeline.map(item => ({ item })), hasOlder: false }; }, append: async row => { rows.push(row); } },
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
    handle: (contract, handler) => { handlers.set(contract.name, handler); },
  });
  t.after(stop);
  return { created, sent, archived, registered, rows, stop,
    rpc: (name, input) => handlers.get(name)(input, { paseo }),
    startTurn() { hooks.get("agent.turn_started")({ agent }, { paseo }); },
    setValues(values) { state = { ...state, values: { ...state.values, ...values }, revision: JSON.stringify(values) }; for (const listener of listeners) listener(state); },
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
  assert.deepEqual(h.registered[0].schema.parse({}), { enabled: true, judgePrompt: DefaultJudgePrompt, judgeProvider: "", judgeModel: "", judgeThinkingOptionId: null, disabledJukes: [], nudgeDelaySeconds: 15, pauseAutoResume: true, pauseAutoResumeMinutes: 5 });
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
  assert.match(h.created[0].prompt, /User-message labels still do not establish human authorship/);
  assert.match(h.created[0].prompt, /Do not assume a single blocked subtask completes or blocks the entire user goal/);
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

test("a delayed nudge waits visibly and is withdrawn when the agent starts another turn", async t => {
  const h = setup(t, { judgeValues: { nudgeDelaySeconds: 15 } });
  await h.fire();
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.rows.map(row => [row.kind, row.data.state]), [["nudge", "pending"]]);
  assert.equal(h.rows[0].data.pattern, "announced-then-stopped");
  h.startTurn();
  await setImmediate();
  assert.deepEqual(h.rows.map(row => row.data.state), ["pending", "superseded"]);
  assert.deepEqual(h.sent, []);
});

test("Send now delivers a waiting nudge and Cancel withdraws one", async t => {
  const h = setup(t, { judgeValues: { nudgeDelaySeconds: 15 } });
  await h.fire();
  assert.deepEqual(await h.rpc("juke.nudge.now", { agentId: "original" }), { sent: true });
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].message, /^\[Juke assessment\] Finish the requested work\./);
  await h.fire();
  assert.deepEqual(await h.rpc("juke.nudge.cancel", { agentId: "original" }), { canceled: true });
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.rows.map(row => row.data.state), ["pending", "sent", "pending", "canceled"]);
  // The app updates a row in place when its id repeats: a nudge keeps one id, a later nudge gets a new one.
  assert.equal(h.rows[0].id, h.rows[1].id);
  assert.equal(h.rows[2].id, h.rows[3].id);
  assert.notEqual(h.rows[0].id, h.rows[2].id);
});

test("/juke-pause stops assessments for that agent until /juke-resume", async t => {
  const h = setup(t, { judgeValues: { pauseAutoResume: false } });
  await h.rpc("juke.pause", { agentId: "original" });
  const { id: pauseId, ...pauseRow } = h.rows.at(-1);
  assert.match(pauseId, /^pause:original:/);
  assert.deepEqual(pauseRow, { type: "plugin", kind: "pause", version: 1, data: { paused: true, autoResumeMinutes: null } });
  await h.fire();
  assert.deepEqual(h.created, []); assert.deepEqual(h.sent, []);
  assert.deepEqual(await h.rpc("juke.resume", { agentId: "original" }), { wasPaused: true });
  await h.fire();
  assert.equal(h.created.length, 1); assert.equal(h.sent.length, 1);
});
