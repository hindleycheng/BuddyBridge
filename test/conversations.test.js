import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Conversations, CONVERSATION_IDLE_TTL, MAX_IDLE_CONVERSATIONS } from '../src/conversations.js';

const user = content => ({ role: 'user', content });
const assistant = content => ({ role: 'assistant', content });
const request = (messages, extra = {}) => ({ conversationKey: 'one', model: { id: 'opencode/a' }, system: 'rules', tools: [], text: JSON.stringify(messages), ...extra });
function fixture() {
  let sequence = 0;
  const discarded = [], leases = [];
  const pool = new Conversations(async id => discarded.push(id));
  const complete = async lease => {
    lease.session ||= { id: `session-${++sequence}` };
    leases.push(structuredClone(lease));
    lease.reusable = true;
    return { choices: [{ message: assistant('answer') }] };
  };
  return { pool, complete, discarded, leases };
}
test('explicit conversation continues with only new messages and cleans up on close', async () => {
  const f = fixture();
  await f.pool.run(request([user('first')]), undefined, f.complete);
  await f.pool.run(request([user('first'), assistant('answer'), user('second')]), undefined, f.complete);
  assert.equal(f.leases[1].session.id, f.leases[0].session.id);
  assert.deepEqual(JSON.parse(f.leases[1].text), [user('second')]);
  assert.deepEqual(f.discarded, []);
  await f.pool.close(); assert.deepEqual(f.discarded, ['session-1']);
});
test('different conversations, edited history, changed declarations and regeneration stay isolated', async () => {
  const f = fixture(); const first = request([user('first')]);
  await f.pool.run(first, undefined, f.complete);
  await f.pool.run({ ...first, conversationKey: 'two' }, undefined, f.complete);
  assert.notEqual(f.leases[0].session.id, f.leases[1].session.id);
  await f.pool.run(first, undefined, f.complete); // Same input can be an intentional regenerate.
  assert.notEqual(f.leases[0].session.id, f.leases[2].session.id);
  await f.pool.run(request([user('edited'), assistant('answer'), user('next')]), undefined, f.complete);
  assert.equal(JSON.parse(f.leases[3].text).length, 3);
  await f.pool.run(request([user('edited'), assistant('answer'), user('next'), assistant('answer'), user('last')], { tools: ['changed'] }), undefined, f.complete);
  assert.equal(JSON.parse(f.leases[4].text).length, 5);
  assert.equal(f.discarded.length, 3);
  await f.pool.close(); assert.equal(f.discarded.length, 5);
});
test('tool IDs are supplied with incremental results; JSON property ordering is irrelevant', async () => {
  const f = fixture();
  const reply = { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'Read', arguments: '{"file_path":"/a"}' } }] };
  await f.pool.run(request([user('first')]), undefined, async lease => {
    await f.complete(lease); return { choices: [{ message: reply }] };
  });
  const toolResult = { role: 'tool', content: 'file content', tool_call_id: 'call_1' };
  await f.pool.run(request([{ content: 'first', role: 'user' }, { ...reply, content: '' }, toolResult]), undefined, f.complete);
  assert.equal(f.leases[1].session.id, 'session-1');
  assert.deepEqual(f.leases[1].toolCalls, [{ id: 'call_1', function: { name: 'Read' } }]); // Do not retain large Write bodies.
  assert.deepEqual(JSON.parse(f.leases[1].text), [toolResult]);
  await f.pool.close();
});
test('continuation sends only new images and changed prior image resets the session', async () => {
  const f = fixture(); const old = { filename: 'message-1-image-1.png', url: 'old' }, next = { filename: 'message-3-image-1.png', url: 'next' };
  await f.pool.run(request([user('picture')], { images: [old] }), undefined, f.complete);
  const messages = [user('picture'), assistant('answer'), user('new picture')];
  await f.pool.run(request(messages, { images: [old, next] }), undefined, f.complete);
  assert.deepEqual(f.leases[1].images, [next]);
  await f.pool.run(request([...messages, assistant('answer'), user('continue')], { images: [{ ...old, url: 'changed' }, next] }), undefined, f.complete);
  assert.notEqual(f.leases[2].session.id, f.leases[1].session.id);
  await f.pool.close();
});
test('same conversation serializes requests and skips canceled queued work', async () => {
  const f = fixture(); let release;
  const first = f.pool.run(request([user('first')]), undefined, async lease => {
    await new Promise(resolve => { release = resolve; }); return f.complete(lease);
  });
  await new Promise(resolve => setImmediate(resolve));
  const controller = new AbortController();
  const canceled = f.pool.run(request([user('cancel')]), controller.signal, f.complete);
  const second = f.pool.run(request([user('first'), assistant('answer'), user('next')]), undefined, f.complete);
  controller.abort(); await assert.rejects(canceled);
  release(); await first; await second;
  assert.equal(f.leases.length, 2);
  assert.equal(f.leases[1].session.id, 'session-1');
  await f.pool.close();
});
test('failed/non-reusable completion is never reused; closing during completion discards the session', async () => {
  const f = fixture();
  await assert.rejects(f.pool.run(request([user('first')]), undefined, async () => { throw Error('upstream'); }));
  await f.pool.run(request([user('first')]), undefined, async lease => {
    const result = await f.complete(lease); lease.reusable = false; return result;
  });
  await f.pool.run(request([user('first'), assistant('answer'), user('next')]), undefined, async lease => {
    const result = await f.complete(lease); await f.pool.close(); return result;
  });
  assert.equal(f.leases[1].session.id, 'session-2');
  assert.deepEqual(f.discarded, ['session-2']);
  await assert.rejects(f.pool.run(request([]), undefined, f.complete), /stopping/);
});

test('idle sessions expire without new traffic, then full client history restores the conversation', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const f = fixture();
  await f.pool.run(request([user('first')]), undefined, f.complete);
  t.mock.timers.tick(CONVERSATION_IDLE_TTL - 1);
  assert.equal(f.pool.entries.size, 1);
  t.mock.timers.tick(1);
  await Promise.resolve();
  assert.equal(f.pool.entries.size, 0);
  assert.deepEqual(f.discarded, ['session-1']);
  const messages = [user('first'), assistant('answer'), user('next')];
  await f.pool.run(request(messages), undefined, f.complete);
  assert.equal(f.leases[1].session.id, 'session-2');
  assert.deepEqual(JSON.parse(f.leases[1].text), messages);
  await f.pool.close();
});
test('reuse renews idle TTL, and a long active request is never evicted', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const f = fixture();
  await f.pool.run(request([user('first')]), undefined, f.complete);
  t.mock.timers.tick(CONVERSATION_IDLE_TTL - 1);
  let release;
  const active = f.pool.run(request([user('first'), assistant('answer'), user('next')]), undefined, async lease => {
    await new Promise(resolve => { release = resolve; }); return f.complete(lease);
  });
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(CONVERSATION_IDLE_TTL * 3);
  assert.deepEqual(f.discarded, []);
  release(); await active;
  assert.equal(f.leases[1].session.id, 'session-1');
  t.mock.timers.tick(CONVERSATION_IDLE_TTL - 1);
  assert.equal(f.pool.entries.size, 1);
  t.mock.timers.tick(1); await Promise.resolve();
  assert.deepEqual(f.discarded, ['session-1']);
  await f.pool.close();
});
test('idle capacity evicts least recently used and leaves an active session untouched', async () => {
  const f = fixture();
  await f.pool.run(request([user('first')]), undefined, f.complete);
  let release;
  const active = f.pool.run(request([user('first'), assistant('answer'), user('next')]), undefined, async lease => {
    await new Promise(resolve => { release = resolve; }); return f.complete(lease);
  });
  await new Promise(resolve => setImmediate(resolve));
  for (let i = 0; i <= MAX_IDLE_CONVERSATIONS; i++)
    await f.pool.run(request([user('first')], { conversationKey: `other-${i}` }), undefined, f.complete);
  assert.equal(f.pool.entries.size, MAX_IDLE_CONVERSATIONS);
  assert.deepEqual(f.discarded, ['session-2']);
  assert.ok(!f.pool.entries.has('other-0'));
  release(); await active;
  assert.equal(f.pool.entries.size, MAX_IDLE_CONVERSATIONS);
  assert.deepEqual(f.discarded, ['session-2', 'session-3']);
  assert.equal(f.leases.at(-1).session.id, 'session-1');
  await f.pool.close();
  assert.equal(new Set(f.discarded).size, MAX_IDLE_CONVERSATIONS + 2);
});
test('shutdown waits for an idle cleanup already in flight and cancels the expiry timer', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  let deleted = 0, release;
  const f = fixture();
  f.pool.discard = async () => { deleted++; await new Promise(resolve => { release = resolve; }); };
  await f.pool.run(request([user('first')]), undefined, f.complete);
  t.mock.timers.tick(CONVERSATION_IDLE_TTL); await Promise.resolve();
  let closed = false;
  const closing = f.pool.close().then(() => { closed = true; });
  await Promise.resolve(); assert.equal(closed, false);
  release(); await closing;
  t.mock.timers.tick(CONVERSATION_IDLE_TTL * 2);
  assert.equal(deleted, 1);
  assert.equal(f.pool.cleanups.size, 0);
});
