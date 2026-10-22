import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cachedProbe, modelFingerprint, probeGate, runProbeQueue, isModelLevelRejection, PROBE_COOLDOWN, PROBE_CACHE_TTL, PROBE_INTERVAL } from '../src/probe-policy.js';

const models = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }];
for (const status of [401, 403, 429]) test(`gateway ${status} stops queue, leaves remaining pending, and requires confirmation during cooldown`, async () => {
  const calls = [], results = {};
  let pending, blockedUntil;
  await runProbeQueue(models, {
    signal: new AbortController().signal,
    probe: async model => { calls.push(model.id); results[model.id] = { ok: false }; return { status }; },
    onPending: ids => pending = ids,
    onBlocked: () => blockedUntil = Date.now() + PROBE_COOLDOWN,
    sleep: () => assert.fail('No sleep or additional requests after rejection'),
  });
  assert.deepEqual(calls, ['a']);
  assert.deepEqual(pending, ['b', 'c']);
  assert.deepEqual(Object.keys(results), ['a']);
  assert.equal(probeGate(blockedUntil).started, false);
  assert.equal(probeGate(blockedUntil, { manual: true }).confirmationRequired, true);
  assert.equal(probeGate(blockedUntil, { manual: true, confirmed: true }), null);
  assert.equal(probeGate(blockedUntil, {}, blockedUntil), null);
});

test('a per-model geo restriction records failure but lets the queue continue', async () => {
  const calls = [];
  let blocked = false;
  await runProbeQueue(models, {
    signal: new AbortController().signal,
    probe: async model => {
      calls.push(model.id);
      return model.id === 'a' ? { status: 403, code: 'model_error', message: 'This model is not available in your country' } : { ok: true };
    },
    onPending() {},
    onBlocked: () => blocked = true,
  });
  assert.deepEqual(calls, ['a', 'b', 'c'], 'geo-blocked model must not veto the rest');
  assert.equal(blocked, false, 'geo block is not a gateway rejection');
});

test('isModelLevelRejection distinguishes per-model restrictions from gateway rejections', () => {
  assert.equal(isModelLevelRejection({ status: 403, code: 'model_error', message: 'This model is not available in your country' }), true);
  assert.equal(isModelLevelRejection({ status: 403, code: 'model_error', message: '模型在当前区域不可用' }), true);
  assert.equal(isModelLevelRejection({ status: 403, code: 'model_error', message: 'FreeTierError' }), false, 'gateway-level free-tier rejection still pauses');
  assert.equal(isModelLevelRejection({ status: 403, code: 'upstream_error', message: 'This model is not available in your country' }), false, 'non-model codes are not geo blocks');
  assert.equal(isModelLevelRejection({ status: 429, code: 'model_error', message: 'not available in your country' }), false, '429 is always gateway-level');
  assert.equal(isModelLevelRejection(undefined), false);
});

test('success cache expires and model declaration changes invalidate it', () => {
  const now = Date.now(), model = models[0];
  const result = { ok: true, time: new Date(now - 1000).toISOString(), catalogFingerprint: modelFingerprint(model) };
  assert.equal(cachedProbe(model, result, undefined, now), true);
  assert.equal(cachedProbe(model, result, undefined, now + PROBE_CACHE_TTL), false);
  assert.equal(cachedProbe({ ...model, images: true }, result, undefined, now), false);
  assert.equal(cachedProbe(model, { ...result, ok: false }, undefined, now), false);
  assert.equal(cachedProbe(model, { ...result, time: 'invalid' }, undefined, now), false);
  assert.equal(cachedProbe(model, { ok: true, time: result.time }, model, now), true, 'Migrate old status with unchanged catalog');
  assert.equal(cachedProbe(model, { ok: true, time: result.time }, undefined, now), false);
  assert.equal(modelFingerprint({ name: 'A', id: 'a' }), modelFingerprint(model));
});

test('interval and jitter are enforced before the next model, abort cancels the wait', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new AbortController(), calls = [];
  const task = runProbeQueue(models, {
    signal: controller.signal, random: () => 0.5,
    sleep: (ms, _, { signal }) => new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    }),
    probe: async model => { calls.push(model.id); },
    onPending() {}, onBlocked() { assert.fail(); },
  });
  await Promise.resolve();
  t.mock.timers.tick(PROBE_INTERVAL + 499);
  await Promise.resolve();
  assert.deepEqual(calls, ['a']);
  t.mock.timers.tick(1);
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(calls, ['a', 'b']);
  controller.abort();
  await task;
  assert.deepEqual(calls, ['a', 'b']);
});

test('access status takes precedence over semantic retry codes', async () => {
  const { probeModel } = await import('../src/probe.js');
  let calls = 0;
  await assert.rejects(probeModel({ complete: async () => {
    calls++; throw Object.assign(new Error('Rejected'), { status: 403, code: 'no_action' });
  } }), { status: 403 });
  assert.equal(calls, 1);
});
