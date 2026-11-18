import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { OWNER } from '../src/sync.js';
import { resolveIntlModelsFile } from '../src/workbuddy-config.js';

test('intl config resolution: only an existing .workbuddy-ai file is picked up; never created', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'buddy-intl-resolve-'));
  try {
    // No directory at all -> null, and nothing gets created.
    assert.equal(await resolveIntlModelsFile({ env: {}, home }), null);
    await assert.rejects(fs.stat(path.join(home, '.workbuddy-ai')), { code: 'ENOENT' });

    // Existing valid file -> resolved; user entries untouched.
    const file = path.join(home, '.workbuddy-ai', 'models.json');
    await fs.mkdir(path.dirname(file));
    await fs.writeFile(file, '\uFEFF[{"id":"glm-5.3-flash","vendor":"Custom","url":"https://open.bigmodel.cn/api/coding/paas/v4","apiKey":"user-key"}]');
    assert.equal(await resolveIntlModelsFile({ env: {}, home }), file);
    // Windows case-insensitivity must not create a second write path.
    assert.equal(await resolveIntlModelsFile({ env: {}, home }), file);

    // Explicit override and kill switch.
    assert.equal(await resolveIntlModelsFile({ env: { BUDDY_NO_INTL_SYNC: '1' }, home }), null);
    const custom = path.join(home, 'intl-custom', 'models.json');
    await fs.mkdir(path.dirname(custom));
    await fs.writeFile(custom, '[]');
    assert.equal(await resolveIntlModelsFile({ env: { BUDDY_INTL_MODELS_FILE: custom }, home }), custom);

    // A malformed intl file is ignored, not fatal.
    await fs.writeFile(file, 'not json');
    assert.equal(await resolveIntlModelsFile({ env: {}, home }), null);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test('intl ride-along sync: import writes both configs, exit cleans both, user entries preserved', { timeout: 60000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'buddy-intl-life-'));
  const intlHome = path.join(root, 'intl-home');
  const config = path.join(root, 'models.json');
  const intlFile = path.join(intlHome, '.workbuddy-ai', 'models.json');
  const manual = { id: 'personal', apiKey: 'keep' };
  const intlManual = { id: 'glm-5.3-flash', name: 'glm-5.3-flash', vendor: 'Custom', url: 'https://example/v4', apiKey: 'intl-user-key' };
  await fs.writeFile(config, JSON.stringify([manual, { id: 'old-owned', buddyBridgeOwner: OWNER }]));
  await fs.mkdir(path.dirname(intlFile), { recursive: true });
  await fs.writeFile(intlFile, JSON.stringify([intlManual, { id: 'intl-owned', buddyBridgeOwner: OWNER }]));
  const catalog = { models: [{ id: 'opencode/a', name: 'A' }], failed: [] };
  await fs.writeFile(path.join(root, 'catalog.json'), JSON.stringify(catalog));
  await fs.writeFile(path.join(root, 'status.json'), JSON.stringify({ models: catalog.models, modelResults: { 'opencode/a': { ok: true, time: new Date().toISOString() } } }));
  await fs.writeFile(path.join(root, 'service.pid'), String(process.pid));
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const child = spawn(process.execPath, ['--loader', new URL('./fixtures/runtime-loader.mjs', import.meta.url).href, 'src/main.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, BUDDY_DATA_DIR: root, BUDDY_PORT: String(port), BUDDY_MODELS_FILE: config, BUDDY_NO_SYNC: '0', BUDDY_DSH_HOME: path.join(root, 'dsh-home'), BUDDY_INTL_MODELS_FILE: intlFile },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let logs = ''; child.stdout.on('data', x => logs += x); child.stderr.on('data', x => logs += x);
  const exited = new Promise(resolve => child.once('exit', resolve));
  async function waitFor(predicate) {
    for (let i = 0; i < 300; i++) {
      let state;
      try { state = JSON.parse(await fs.readFile(path.join(root, 'status.json'), 'utf8')); } catch {}
      if (state && predicate(state)) return state;
      if (child.exitCode !== null) throw new Error(logs);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Intl lifecycle timeout: ' + logs);
  }
  const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
  try {
    // Startup import reaches both configs; each keeps only its own manual entry plus ours.
    await waitFor(s => s.phase === 'ready' && !s.probe.running && s.sync?.count === 1 && s.intl?.sync?.count === 1);
    assert.deepEqual((await read(config)).map(m => m.id), ['personal', 'BB · A']);
    assert.deepEqual((await read(intlFile)).map(m => m.id), ['glm-5.3-flash', 'BB · A']);
    const key = (await fs.readFile(path.join(root, 'api-key'), 'utf8')).trim();

    // Manual import reports both targets; result envelope carries intl.
    const response = await fetch(`http://127.0.0.1:${port}/admin/import`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: '{}' });
    const result = await response.json();
    assert.ok(response.ok, JSON.stringify(result));
    assert.equal(result.count, 1);
    assert.equal(result.intl.count, 1);
    assert.equal(result.intl.changed, false, 'Second import of the same catalog is a no-op');

    // Selecting none cleans both sides on the next import.
    await fetch(`http://127.0.0.1:${port}/admin/selection`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'opencode/a', selected: false }) });
    await fetch(`http://127.0.0.1:${port}/admin/import`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: '{}' });
    assert.deepEqual(await read(config), [manual]);
    assert.deepEqual(await read(intlFile), [intlManual]);

    // Exit cleans the intl config as well.
    child.send('shutdown'); await exited;
    assert.deepEqual(await read(config), [manual], 'Exit cleans the selected configuration');
    assert.deepEqual(await read(intlFile), [intlManual], 'Exit cleans the intl configuration');
  } finally {
    if (child.exitCode === null) { child.send('shutdown'); await exited; }
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('intl sync stays silent when the intl config does not exist', { timeout: 60000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'buddy-intl-none-'));
  const config = path.join(root, 'models.json');
  await fs.writeFile(config, JSON.stringify([{ id: 'personal', apiKey: 'keep' }]));
  await fs.writeFile(path.join(root, 'catalog.json'), JSON.stringify({ models: [{ id: 'opencode/a', name: 'A' }], failed: [] }));
  await fs.writeFile(path.join(root, 'status.json'), JSON.stringify({ models: [{ id: 'opencode/a', name: 'A' }], modelResults: { 'opencode/a': { ok: true, time: new Date().toISOString() } } }));
  await fs.writeFile(path.join(root, 'service.pid'), String(process.pid));
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  // BUDDY_INTL_MODELS_FILE points into root: it does not exist, so no intl target.
  const child = spawn(process.execPath, ['--loader', new URL('./fixtures/runtime-loader.mjs', import.meta.url).href, 'src/main.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, BUDDY_DATA_DIR: root, BUDDY_PORT: String(port), BUDDY_MODELS_FILE: config, BUDDY_NO_SYNC: '0', BUDDY_INTL_MODELS_FILE: path.join(root, 'absent', 'models.json') },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let logs = ''; child.stdout.on('data', x => logs += x); child.stderr.on('data', x => logs += x);
  const exited = new Promise(resolve => child.once('exit', resolve));
  async function waitFor(predicate) {
    for (let i = 0; i < 300; i++) {
      let state;
      try { state = JSON.parse(await fs.readFile(path.join(root, 'status.json'), 'utf8')); } catch {}
      if (state && predicate(state)) return state;
      if (child.exitCode !== null) throw new Error(logs);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Intl none timeout: ' + logs);
  }
  try {
    const ready = await waitFor(s => s.phase === 'ready' && !s.probe.running && s.sync?.count === 1);
    assert.equal(ready.intl, undefined, 'No intl state when the config is absent');
    await assert.rejects(fs.stat(path.join(root, 'absent')), { code: 'ENOENT' }, 'Absent intl config must not be created');
    child.send('shutdown'); await exited;
  } finally {
    if (child.exitCode === null) { child.send('shutdown'); await exited; }
    await fs.rm(root, { recursive: true, force: true });
  }
});
