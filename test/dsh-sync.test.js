import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { dshPaths, dshModelEntry, buildProviderBlock, mergePatchYaml, removePatchEntry, mergeCredentials, removeCredential, syncDshProvider, DSH_API_KEY_ENV } from '../src/dsh-sync.js';

const models = [
  { id: 'opencode/a', name: 'Model A', context: 100000, input: 80000, output: 16000, images: true },
  { id: 'opencode/b', name: 'Model B' },
];
const block = buildProviderBlock(models, 'http://127.0.0.1:41980/v1');

const realPatch = `- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: deepseek-account
    model: deepseek-flash
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      zai-coding-cn:
        apiKeyEnv: ZAI_CODING_CN_API_KEY
        models:
          - id: glm-5.3
            name: GLM-5.3
            contextWindow: 1000000
            maxTokens: 131072
            input:
              - text
`;

test('model entry maps catalog limits to DSH fields and quotes ids', () => {
  assert.deepEqual(dshModelEntry(models[0]), { id: 'BB · Model A', name: 'BB · Model A', contextWindow: 80000, maxTokens: 16000, input: ['text', 'image'] });
  assert.deepEqual(dshModelEntry(models[1]), { id: 'BB · Model B', name: 'BB · Model B', input: ['text'] });
  assert.ok(block.includes('          - id: "BB · Model A"'));
  assert.ok(block.includes('        baseURL: http://127.0.0.1:41980/v1'));
  assert.ok(block.includes(`        apiKeyEnv: ${DSH_API_KEY_ENV}`));
});

test('inserts the provider beside existing providers and preserves them', () => {
  const { text, changed } = mergePatchYaml(realPatch, block);
  assert.equal(changed, true);
  assert.ok(text.includes('      zai-coding-cn:'));
  assert.ok(text.includes('      buddybridge:'));
  assert.ok(text.indexOf('      zai-coding-cn:') < text.indexOf('      buddybridge:'));
  assert.ok(text.includes('- id: agent-default-model'));
  // Idempotent re-import: replacing our own block with identical content is a no-op.
  const again = mergePatchYaml(text, block);
  assert.equal(again.changed, false);
});

test('appends a full llm-pi-ai entry when the patch has none', () => {
  const { text } = mergePatchYaml('- id: agent-default-model\n  name: x\n  config:\n    provider: deepseek-account\n', buildProviderBlock([models[0]], 'http://x/v1'));
  assert.ok(text.includes('- id: llm-pi-ai'));
  assert.ok(text.includes('    providers:'));
  assert.ok(text.trimEnd().endsWith('- image'));
});

test('removal excises only our block, then the whole entry when it was ours alone', () => {
  const inserted = mergePatchYaml(realPatch, block);
  const removed = removePatchEntry(inserted.text);
  assert.equal(removed.changed, true);
  assert.ok(removed.text.includes('      zai-coding-cn:'));
  assert.ok(!removed.text.includes('buddybridge'));
  assert.equal(removePatchEntry(removed.text).changed, false);
  const appended = mergePatchYaml('- id: other\n  name: x\n', buildProviderBlock([models[1]], 'http://x/v1'));
  const full = removePatchEntry(appended.text);
  assert.ok(!full.text.includes('llm-pi-ai'));
  assert.ok(full.text.includes('- id: other'));
});

test('credentials ref is added, updated, and removed without touching other refs', () => {
  const base = 'version: 1\nrecords:\n  a:\n    kind: grant\nrefs:\n  ZAI_CODING_CN_API_KEY: abc\n';
  const added = mergeCredentials(base, 'k1');
  assert.ok(added.text.includes(`  ${DSH_API_KEY_ENV}: k1`));
  assert.ok(added.text.includes('  ZAI_CODING_CN_API_KEY: abc'));
  assert.equal(mergeCredentials(added.text, 'k1').changed, false);
  assert.ok(mergeCredentials(added.text, 'k2').text.includes(`  ${DSH_API_KEY_ENV}: k2`));
  const removed = removeCredential(added.text);
  assert.ok(removed.text.includes('ZAI_CODING_CN_API_KEY'));
  assert.ok(!removed.text.includes(DSH_API_KEY_ENV));
  const lone = mergeCredentials('version: 1\nrefs:\n', 'k3');
  const gone = removeCredential(lone.text);
  assert.ok(!gone.text.includes('refs:'), 'Empty refs section is dropped');
  assert.equal(mergeCredentials('version: 1\n', 'k4').text.includes('refs:'), true);
});

test('syncDshProvider round trip: write, verify, clean up, with backup', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-'));
  const dsh = { patch: path.join(root, 'cordis.patch.yml'), credentials: path.join(root, '.credentials.yaml') };
  try {
    await fs.writeFile(dsh.patch, realPatch);
    await fs.writeFile(dsh.credentials, 'version: 1\nrefs:\n  ZAI_CODING_CN_API_KEY: abc\n');
    const first = await syncDshProvider(dsh, models, 'http://127.0.0.1:41980/v1', 'local-key');
    assert.equal(first.changed, true);
    assert.equal(first.count, 2);
    const patchText = await fs.readFile(dsh.patch, 'utf8');
    assert.ok(patchText.includes('buddybridge:'));
    assert.ok((await fs.readFile(dsh.credentials, 'utf8')).includes('BUDDY_BRIDGE_API_KEY: local-key'));
    const backups = (await fs.readdir(root)).filter(name => name.includes('.bak'));
    assert.equal(backups.length, 1, 'One rolling backup per change');
    const again = await syncDshProvider(dsh, models, 'http://127.0.0.1:41980/v1', 'local-key');
    assert.equal(again.changed, false);
    const cleanup = await syncDshProvider(dsh, [], '', '');
    assert.equal(cleanup.changed, true);
    const cleaned = await fs.readFile(dsh.patch, 'utf8');
    assert.ok(cleaned.includes('zai-coding-cn:'));
    assert.ok(!cleaned.includes('buddybridge'));
    assert.ok(!(await fs.readFile(dsh.credentials, 'utf8')).includes('BUDDY_BRIDGE_API_KEY'));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('missing patch file reports an actionable error and dshPaths respects overrides', () => {
  const root = '/nonexistent-dsh';
  assert.deepEqual(dshPaths(root, 'web'), { home: root, profile: 'web', patch: `${root}/profiles/web/cordis.patch.yml`, credentials: `${root}/.credentials.yaml` });
  return assert.rejects(syncDshProvider({ patch: `${root}/p.yml`, credentials: `${root}/c.yaml` }, models, 'x', 'y'), /未找到 DeepSeek Harness/);
});
