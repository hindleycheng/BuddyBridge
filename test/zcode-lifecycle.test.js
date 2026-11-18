import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { OWNER } from '../src/sync.js';

test('zcode ride-along: service writes manual rules, selection gates them, exit cleans', { timeout: 90000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'buddy-zcode-life-'));
  const zcodeHome = path.join(root, 'zcode-home');
  const zcodeFile = path.join(zcodeHome, 'v2', 'provider_config.json');
  const config = path.join(root, 'models.json');
  const manual = { id: 'personal', apiKey: 'keep' };
  await fs.writeFile(config, JSON.stringify([manual]));
  await fs.mkdir(path.dirname(zcodeFile), { recursive: true });
  await fs.writeFile(zcodeFile, JSON.stringify({
    schemaVersion: 1,
    config: { providerConfigRules: { providerRules: [] }, modelConfigRules: { providerModelRules: [], manualProviderModelRules: [{ providerId: 'other', modelId: 'm1', config: {} }] } },
  }, null, 2));
  await fs.writeFile(path.join(root, 'catalog.json'), JSON.stringify({ models: [{ id: 'opencode/a', name: 'A', context: 200000, output: 64000 }], failed: [] }));
  await fs.writeFile(path.join(root, 'status.json'), JSON.stringify({ models: [{ id: 'opencode/a', name: 'A', context: 200000, output: 64000 }], modelResults: { 'opencode/a': { ok: true, time: new Date().toISOString() } } }));
  await fs.writeFile(path.join(root, 'service.pid'), String(process.pid));
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const child = spawn(process.execPath, ['--loader', new URL('./fixtures/runtime-loader.mjs', import.meta.url).href, 'src/main.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, BUDDY_DATA_DIR: root, BUDDY_PORT: String(port), BUDDY_MODELS_FILE: config, BUDDY_NO_SYNC: '0', BUDDY_DSH_HOME: path.join(root, 'dsh-absent'), BUDDY_INTL_MODELS_FILE: path.join(root, 'intl-absent', 'models.json'), BUDDY_ZCODE_HOME: zcodeHome },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let logs = ''; child.stdout.on('data', x => logs += x); child.stderr.on('data', x => logs += x);
  const exited = new Promise(resolve => child.once('exit', resolve));
  async function waitFor(predicate) {
    for (let i = 0; i < 400; i++) {
      let state;
      try { state = JSON.parse(await fs.readFile(path.join(root, 'status.json'), 'utf8')); } catch {}
      if (state && predicate(state)) return state;
      if (child.exitCode !== null) throw new Error(logs);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('ZCode lifecycle timeout: ' + logs);
  }
  const read = async () => JSON.parse(await fs.readFile(zcodeFile, 'utf8'));
  const ours = () => read().then(d => (d.config.modelConfigRules.manualProviderModelRules || []).filter(r => r.providerId === 'buddybridge'));
  try {
    // Startup import writes the rule alongside the foreign one.
    await waitFor(s => s.phase === 'ready' && !s.probe.running && s.sync?.count === 1 && s.zcode?.sync?.count === 1);
    let rules = await ours();
    assert.equal(rules.length, 1);
    assert.equal(rules[0].modelId, 'BB · A');
    assert.equal(rules[0].config.properties.contextWindow, 200000);
    assert.ok(!('supportsToolCall' in rules[0].config.properties));
    assert.equal((await read()).config.modelConfigRules.manualProviderModelRules.filter(r => r.providerId === 'other').length, 1, 'foreign rules kept');
    const key = (await fs.readFile(path.join(root, 'api-key'), 'utf8')).trim();

    // Turning zcode off removes only our rule immediately.
    const response = await fetch(`http://127.0.0.1:${port}/admin/prefs`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ targets: { zcode: false } }) });
    assert.ok(response.ok, await response.text());
    assert.equal((await ours()).length, 0);
    assert.equal((await read()).config.modelConfigRules.manualProviderModelRules.filter(r => r.providerId === 'other').length, 1);

    // Turning it back on restores the rule.
    const on = await fetch(`http://127.0.0.1:${port}/admin/prefs`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ targets: { zcode: true } }) });
    assert.ok(on.ok);
    assert.equal((await ours()).length, 1);

    // Exit cleanup removes our rule, keeps everything else.
    child.send('shutdown'); await exited;
    assert.equal((await ours()).length, 0, 'exit cleans our zcode rules');
    const foreign = (await read()).config.modelConfigRules.manualProviderModelRules.filter(r => r.providerId === 'other');
    assert.equal(foreign.length, 1);
    assert.deepEqual(JSON.parse(await fs.readFile(config, 'utf8')), [manual]);
  } finally {
    if (child.exitCode === null) { child.send('shutdown'); await exited; }
    await fs.rm(root, { recursive: true, force: true });
  }
});
