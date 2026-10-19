import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { BackendV2, freeModelsV2, isolatedConfigV2 } from '../src/backend-v2.js';
import { prepare } from '../src/protocol.js';
import { probeBody, judgeProbe } from '../src/probe.js';
import { runtimeVersion } from '../src/runtime.js';

const model = { id: 'opencode/test', name: 'Test', variants: {} };
test('V2 versions, tiered prices and capability declarations are normalized conservatively', () => {
  assert.equal(runtimeVersion('opencode v2.0.32\n'), '2.0.32');
  assert.equal(runtimeVersion('1.19.3\n'), '1.19.3');
  const entry = { id: 'test', providerID: 'opencode', enabled: true, status: 'active', name: 'Test',
    capabilities: { input: ['text', 'image'], output: ['text'], tools: true }, limit: { context: 200000, output: 32000 },
    variants: [{ id: 'high', settings: { reasoningEffort: 'high' } }], cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }] };
  const models = freeModelsV2({ data: [entry, { ...entry, id: 'paid-tier', cost: [...entry.cost, { input: 1, output: 0 }] }, { ...entry, id: 'disabled', enabled: false }] });
  assert.equal(models.length, 1);
  assert.equal(models[0].images, true);
  assert.equal(models[0].reasoning, true);
  assert.deepEqual(models[0].variants, { high: { reasoningEffort: 'high' } });
  assert.deepEqual(isolatedConfigV2.agents['buddy-bridge'].permissions[0], { action: '*', resource: '*', effect: 'ask' });
});

async function fixture(t, mode) {
  const calls = []; let messages = [], waiting, pending = [];
  const server = http.createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : undefined;
    calls.push({ route: req.url, method: req.method, body });
    const json = data => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); };
    const empty = () => { res.writeHead(204); res.end(); };
    if (req.url === '/api/session' && req.method === 'POST') return json({ data: { id: 'ses_test' } });
    if (req.url.endsWith('/agent') || req.url.endsWith('/model')) return empty();
    if (req.url.endsWith('/prompt')) {
      const content = mode === 'handoff' ? [{ type: 'tool', name: 'read', id: 'call_test', state: { status: 'running', input: { filePath: '/external/probe-abc.txt' } } }]
        : [{ type: 'text', text: JSON.stringify({ content: '', calls: [{ name: 'Read', arguments: { file_path: '/external/probe-abc.txt' } }] }) }];
      messages = [{ id: 'msg_test', type: 'assistant', content,
        ...(mode === 'error' ? { error: { type: 'provider.auth', message: 'Access denied', status: 403 } } : {}) }];
      if (mode === 'handoff') pending = [{ id: 'per_test', sessionID: 'ses_test', action: 'read', resources: ['/external/probe-abc.txt'], source: { type: 'tool', id: 'call_test', messageID: 'msg_test' } }];
      return json({ data: {} });
    }
    if (req.url.endsWith('/wait')) {
      if (mode === 'handoff' || mode === 'cancel') { waiting = res; return; }
      return empty();
    }
    if (req.url.includes('/message?')) return json({ data: messages, cursor: {} });
    if (req.url === '/api/permission/request') return json({ data: pending });
    if (req.url.endsWith('/reply')) { assert.equal(body.decision, 'reject'); pending = []; return empty(); }
    if (req.url.endsWith('/interrupt')) { waiting?.writeHead(204); waiting?.end(); return empty(); }
    if (req.method === 'DELETE') return empty();
    res.writeHead(404); res.end('{}');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { backend: new BackendV2(`http://127.0.0.1:${server.address().port}`, 'test'), calls };
}
for (const mode of ['text', 'handoff']) test(`V2 ${mode} returns external tools, rejects native permissions and cleans up`, async t => {
  const { backend, calls } = await fixture(t, mode);
  const meta = {};
  const result = await backend.complete(prepare(probeBody(model, 'abc'), [model]), AbortSignal.timeout(5000), meta);
  judgeProbe(result, 'abc');
  assert.ok(calls.some(c => c.method === 'DELETE'));
  if (mode === 'handoff') {
    assert.equal(meta.handoff, 'Read');
    assert.ok(calls.some(c => c.route.endsWith('/interrupt')));
    assert.ok(calls.some(c => c.route.endsWith('/reply') && c.body.decision === 'reject'));
  }
  assert.ok(calls.find(c => c.route === '/api/session').body.permissions.every(p => p.effect !== 'allow'));
});
test('V2 upstream errors retain their status; cancellation interrupts and deletes the session', async t => {
  const error = await fixture(t, 'error');
  await assert.rejects(error.backend.complete(prepare(probeBody(model, 'abc'), [model]), AbortSignal.timeout(5000)), e => e.status === 403 && e.message === 'Access denied');
  const cancel = await fixture(t, 'cancel');
  await assert.rejects(cancel.backend.complete(prepare(probeBody(model, 'abc'), [model]), AbortSignal.timeout(80)));
  assert.ok(cancel.calls.some(c => c.route.endsWith('/interrupt')));
  assert.ok(cancel.calls.some(c => c.method === 'DELETE'));
});

test('V2 continuation reuses session, sends delta plus tool IDs, and does not repeat protocol instructions', async t => {
  const { backend, calls } = await fixture(t, 'text');
  const body = probeBody(model, 'abc');
  const first = { ...prepare(body, [model]), conversationKey: 'conversation' };
  const result = await backend.complete(first, AbortSignal.timeout(5000));
  const reply = result.choices[0].message;
  const tool = { role: 'tool', tool_call_id: reply.tool_calls[0].id, content: 'file content' };
  await backend.complete({ ...prepare({ ...body, messages: [...body.messages, reply, tool] }, [model]), conversationKey: 'conversation' }, AbortSignal.timeout(5000));
  assert.equal(calls.filter(c => c.route === '/api/session').length, 1);
  assert.equal(calls.filter(c => c.method === 'DELETE').length, 0);
  const prompts = calls.filter(c => c.route.endsWith('/prompt'));
  assert.match(prompts[0].body.text, /matching this schema/);
  assert.doesNotMatch(prompts[1].body.text, /matching this schema/);
  assert.match(prompts[1].body.text, /file content/);
  assert.ok(prompts[1].body.text.includes(reply.tool_calls[0].id));
  assert.ok(!prompts[1].body.text.includes(body.messages[0].content));
  await backend.closeSessions();
  assert.equal(calls.filter(c => c.method === 'DELETE').length, 1);
});

test('V2 snapshots request newest messages so long retained sessions do not return the first page', async t => {
  const server = http.createServer((req, res) => {
    assert.equal(new URL(req.url, 'http://localhost').searchParams.get('order'), 'desc');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'new', type: 'assistant', content: [] }, { id: 'old', type: 'assistant', content: [] }] }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const backend = new BackendV2(`http://127.0.0.1:${server.address().port}`, 'test');
  assert.deepEqual((await backend.snapshot('session')).map(m => m.info.id), ['old', 'new']);
});
