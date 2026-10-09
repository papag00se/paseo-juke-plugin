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
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const verdict = { status: "idle", lastMessage: JSON.stringify({ decision: "continue", rationale: "Work remains", followUp: "Finish the requested work." }) };

function setup(t, { enabled = true, judgeValues = {}, preparation, judgement } = {}) {
  const hooks = new Map(), created = [], sent = [], archived = [], registered = [];
  // Revisions are content-addressed, not monotonic: false → true restores the
  // original revision. Subscribers must still invalidate the old assessment.
  let state = { status: "ready", values: { enabled, judgeProvider: "", judgeModel: "", judgeThinkingOptionId: null, ...judgeValues }, revision: String(enabled) };
  const listeners = new Set();
  t.mock.method(console, "log", () => {});
  const agent = { id: "original", workspaceId: "workspace", provider: "test", model: "test-model", labels: {} };
  const paseo = {
    agents: { ref: id => ({
      refresh: async () => { if (preparation) await preparation.promise; return { agent }; },
      send: async message => { sent.push({ id, message }); },
      archive: async () => { archived.push(id); },
    }) },
    workspaces: { ref: () => ({ agents: { create: async options => {
      created.push(options);
      return { id: "judge", waitForFinish: async () => judgement ? judgement.promise : verdict, send: async () => {} };
    } } }) },
  };
  const stop = contribute({
    registerSettings: definition => { registered.push(definition); return { read: async () => state, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); } }; },
    on: (name, handler) => { hooks.set(name, handler); return () => hooks.delete(name); },
  });
  t.after(stop);
  return { created, sent, archived, registered, stop,
    change(enabled) { state = { ...state, values: { ...state.values, enabled }, revision: String(enabled) }; for (const listener of listeners) listener(state); },
    async fire() {
      hooks.get("agent.turn_ended")({ agent, outcome: { kind: "completed" }, timeline: [{ type: "user_message", text: "Finish the work." }], turnId: "turn" }, { paseo });
      await setImmediate();
    },
  };
}

test("native settings preserve automatic assessment by default; enabled runs still reuse the original model", async t => {
  const h = setup(t); await h.fire();
  assert.equal(h.registered[0].scope, "host");
  assert.deepEqual(h.registered[0].schema.parse({}), { enabled: true, judgeProvider: "", judgeModel: "", judgeThinkingOptionId: null });
  assert.deepEqual(h.registered[0].schema.parse({ enabled: false }).enabled, false);
  assert.equal(h.created.length, 1);
  assert.equal(h.created[0].config.provider, "test/test-model");
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].message, /^\[Juke assessment\]/);
  assert.deepEqual(h.archived, ["judge"]);
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
