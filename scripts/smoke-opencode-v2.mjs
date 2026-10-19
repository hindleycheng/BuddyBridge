import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startBackend } from '../src/runtime.js';
import { systemProxyEnvironment } from '../src/system-proxy.js';
import { createServer } from '../src/server.js';
import { probeBody, judgeProbe } from '../src/probe.js';

if (!process.argv[2]) throw new Error('Usage: node scripts/smoke-opencode-v2.mjs <binary> [--proxy]');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-v2-roundtrip-'));
console.log('ROOT', root);
const log = fs.createWriteStream(path.join(root, 'runtime.log'));
const runtime = await startBackend(path.resolve(process.argv[2]), root, log,
  await systemProxyEnvironment(process.argv.includes('--proxy')));
let server;
try {
  if (!runtime.version.startsWith('2.')) throw new Error('Expected OpenCode 2');
  const models = await runtime.backend.models();
  console.log('RUNTIME', runtime.version, 'MODELS', models.length, 'PROXY', process.argv.includes('--proxy'));
  console.log('MODEL_IDS', models.map(m => m.id).join(','));
  server = createServer({ key: 'test-only', backend: runtime.backend, getModels: () => models, status: () => ({}),
    onResult: (model, ok, error, s, c, d, src, chat, meta) => console.log('META', JSON.stringify({
      model, ok, error, calls: meta.calls, nativeAttempts: meta.nativeAttempts, handoff: meta.handoff,
    })),
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const call = async body => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, {
      method: 'POST', headers: { Authorization: 'Bearer test-only', 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(90000), // Test deadline only.
    });
    if (res.status !== 200) throw new Error(await res.text());
    return body.stream ? res.text() : res.json();
  };
  for (const id of ['opencode/big-pickle', 'opencode/space-bunny-free']) {
    try {
      const model = models.find(m => m.id === id);
      if (!model) throw new Error('Model is absent from the current free catalog');
      const body = probeBody(model, 'roundtrip');
      const first = await call(body);
      const tool = judgeProbe(first, 'roundtrip');
      console.log('TOOL_PASS', id);
      const messages = [...body.messages, first.choices[0].message,
        { role: 'tool', tool_call_id: tool.id, content: 'OW-V2-ROUNDTRIP-OK' }];
      const second = await call({ ...body, messages, stream: true });
      const events = second.split(/\r?\n/).filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trim());
      const chunks = events.filter(data => data !== '[DONE]').map(data => JSON.parse(data));
      const answer = chunks.map(chunk => chunk.choices?.[0]?.delta?.content || '').join('');
      if (!events.includes('[DONE]') || chunks.some(chunk => chunk.error) || !answer.includes('OW-V2-ROUNDTRIP-OK'))
        throw new Error(second);
      console.log('SSE_ROUNDTRIP_PASS', id);
    } catch (error) {
      console.log('MODEL_FAIL', id, error.message);
      process.exitCode = 1;
    }
  }
} finally {
  server?.closeAllConnections();
  server?.close();
  await runtime.stop();
  log.end();
}
