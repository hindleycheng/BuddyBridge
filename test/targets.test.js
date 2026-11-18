import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { OWNER } from '../src/sync.js';

test('write targets: user selection gates each platform and disabling cleans only our entries', { timeout: 90000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'buddy-targets-'));
  const config = path.join(root, 'models.json');
  const intlFile = path.join(root, 'intl', '.workbuddy-ai', 'models.json');
  const dshHome = path.join(root, 'dsh-home');
  const dshPatch = path.join(dshHome, 'profiles', 'desktop', 'cordis.patch.yml');
  const manual = { id: 'personal', apiKey: 'keep' };
  const intlManual = { id: 'glm-5.3-flash', vendor: 'Custom', url: 'https://example/v4', apiKey: 'intl-key' };
  await fs.writeFile(config, JSON.stringify([manual, { id: 'old-owned', buddyBridgeOwner: OWNER }]));
  await fs.mkdir(path.dirname(intlFile), { recursive: true });
  await fs.writeFile(intlFile, JSON.stringify([intlManual]));
  await fs.mkdir(path.dirname(dshPatch), { recursive: true });
  await fs.writeFile(dshPatch, '');
  await fs.writeFile(path.join(root, 'catalog.json'), JSON.stringify({ models: [{ id: 'opencode/a', name: 'A' }], failed: [] }));
  await fs.writeFile(path.join(root, 'status.json'), JSON.stringify({ models: [{ id: 'opencode/a', name: 'A' }], modelResults: { 'opencode/a': { ok: true, time: new Date().toISOString() } } }));
  await fs.writeFile(path.join(root, 'service.pid'), String(process.pid));
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const child = spawn(process.execPath, ['--loader', new URL('./fixtures/runtime-loader.mjs', import.meta.url).href, 'src/main.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, BUDDY_DATA_DIR: root, BUDDY_PORT: String(port), BUDDY_MODELS_FILE: config, BUDDY_NO_SYNC: '0', BUDDY_DSH_HOME: dshHome, BUDDY_DSH_PROFILE: 'desktop', BUDDY_INTL_MODELS_FILE: intlFile, BUDDY_ZCODE_HOME: path.join(root, 'zcode-absent') },
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
    throw new Error('Targets timeout: ' + logs);
  }
  const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
  const ids = async file => (await read(file)).map(m => m.id);
  const key = async () => (await fs.readFile(path.join(root, 'api-key'), 'utf8')).trim();
  async function prefs(targets) {
    const response = await fetch(`http://127.0.0.1:${port}/admin/prefs`, { method: 'POST', headers: { Authorization: `Bearer ${await key()}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ targets }) });
    const result = await response.json();
    assert.ok(response.ok, JSON.stringify(result));
    return result;
  }
  try {
    // Defaults: every detected platform is on, and each holds only its own entries plus ours.
    const ready = await waitFor(s => s.phase === 'ready' && !s.probe.running && s.sync?.count === 1 && s.targets);
    assert.equal(ready.targets.domestic.enabled, true);
    assert.equal(ready.targets.intl.enabled, true);
    assert.equal(ready.targets.dsh.enabled, true);
    assert.equal(ready.targets.intl.available, true);
    assert.equal(ready.targets.dsh.available, true);
    assert.deepEqual(await ids(config), ['personal', 'BB · A']);
    assert.deepEqual(await ids(intlFile), ['glm-5.3-flash', 'BB · A']);
    assert.match(await fs.readFile(dshPatch, 'utf8'), /buddybridge/);

    // Turning intl off cleans its entries immediately but leaves domestic and DSH intact.
    let result = await prefs({ intl: false });
    assert.equal(result.targets.intl.enabled, false);
    assert.deepEqual(await read(intlFile), [intlManual]);
    assert.deepEqual(await ids(config), ['personal', 'BB · A']);
    assert.match(await fs.readFile(dshPatch, 'utf8'), /buddybridge/);

    // Turning domestic off cleans it too; DSH still present.
    result = await prefs({ domestic: false });
    assert.equal(result.targets.domestic.enabled, false);
    assert.deepEqual(await read(config), [manual]);
    assert.match(await fs.readFile(dshPatch, 'utf8'), /buddybridge/);
    const off = await waitFor(s => s.targets.domestic.enabled === false && s.sync?.count === 0);
    assert.equal(off.sync.error, undefined, 'A disabled domestic target is not an error');

    // Turning DSH off removes the provider block but keeps DSH's other content.
    result = await prefs({ dsh: false });
    assert.equal(result.targets.dsh.enabled, false);
    assert.doesNotMatch(await fs.readFile(dshPatch, 'utf8'), /buddybridge/);

    // Re-enabling restores models only on the chosen platform.
    result = await prefs({ domestic: true });
    assert.equal(result.targets.domestic.enabled, true);
    assert.deepEqual(await ids(config), ['personal', 'BB · A']);
    assert.deepEqual(await read(intlFile), [intlManual], 'Intl stays off until re-enabled');

    result = await prefs({ intl: true, dsh: true });
    assert.equal(result.targets.intl.enabled, true);
    assert.equal(result.targets.dsh.enabled, true);
    assert.deepEqual(await ids(intlFile), ['glm-5.3-flash', 'BB · A']);
    assert.match(await fs.readFile(dshPatch, 'utf8'), /buddybridge/);

    // Preferences survive a restart and still gate the exit cleanup of our entries.
    child.send('shutdown'); await exited;
    assert.deepEqual(await read(config), [manual]);
    assert.deepEqual(await read(intlFile), [intlManual]);
    assert.doesNotMatch(await fs.readFile(dshPatch, 'utf8'), /buddybridge/);
    const saved = JSON.parse(await fs.readFile(path.join(root, 'settings.json'), 'utf8'));
    assert.deepEqual(saved.targets, { domestic: true, intl: true, dsh: true });
  } finally {
    if (child.exitCode === null) { child.send('shutdown'); await exited; }
    await fs.rm(root, { recursive: true, force: true });
  }
});
