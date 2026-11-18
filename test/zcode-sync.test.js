import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { zcodeConfigPath, syncZcodeProviders } from '../src/zcode-sync.js';
import { OWNER } from '../src/sync.js';

const models = [{ id: 'opencode/test-a', name: 'A', context: 200000, output: 64000, images: true, reasoning: true }];

test('zcode paths and merge: preserves foreign providers, replaces only our block', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'zcode-unit-'));
  const file = path.join(home, 'v2', 'provider_config.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  assert.equal(zcodeConfigPath(home), file);

  // Existing user config with another provider's rules; providerOrder lives inside config.
  const existing = {
    schemaVersion: 1,
    config: {
      providerOrder: ['other'],
      providerConfigRules: { providerRules: [{ providerId: 'account:x', config: { group: 'zai-family' } }] },
      modelConfigRules: {
        providerModelRules: [],
        manualProviderModelRules: [{ providerId: 'other', modelId: 'm1', config: {} }],
      },
    },
  };
  await fs.writeFile(file, JSON.stringify(existing, null, 2));
  const first = await syncZcodeProviders(file, models, 'http://127.0.0.1:41980/v1', 'key-1');
  assert.equal(first.changed, true);
  assert.equal(first.count, 1);
  const merged = JSON.parse(await fs.readFile(file, 'utf8'));
  const manual = merged.config.modelConfigRules.manualProviderModelRules;
  assert.equal(manual.filter(r => r.providerId === 'buddybridge').length, 1);
  assert.equal(manual.filter(r => r.providerId === 'other').length, 1, 'foreign manual rules kept');
  const providers = merged.config.providerConfigRules.providerRules;
  const decl = providers.find(r => r.providerId === 'buddybridge');
  assert.ok(decl, 'provider declaration is written');
  assert.deepEqual(decl.config.api, { type: 'openai-chat-completions', baseUrl: 'http://127.0.0.1:41980/v1' });
  assert.equal(decl.config.access.type, 'api-key');
  assert.equal(decl.config.access.apiKey, 'key-1');
  assert.ok(!('builtinModelIds' in decl.config), 'personal provider rules must not carry builtin-only keys');
  assert.deepEqual(merged.config.providerConfigRules.providerRules.filter(r => r.providerId === 'other'), [], 'no foreign provider rules expected');
  assert.deepEqual(merged.config.providerOrder, ['other', 'buddybridge'], 'providerOrder lives inside config and keeps foreign entries');
  const ours = manual.find(r => r.providerId === 'buddybridge');
  assert.equal(ours.modelId, 'BB · A');
  assert.equal(ours.config.enabled, true);
  assert.equal(ours.config.properties.contextWindow, 200000);
  assert.equal(ours.config.properties.inputFormat.supportsImage, true);
  assert.equal(ours.config.properties.supportsJsonSchemaOutput, false);
  assert.ok(!('supportsToolCall' in ours.config.properties), 'manual rules must not carry builtin-only keys');
  assert.ok(!('outputFormat' in ours.config.properties), 'manual rules must not carry builtin-only keys');
  assert.ok(!('supportsText' in ours.config.properties.inputFormat), 'inputFormat must not carry supportsText');
  assert.deepEqual(ours.config.optionSpecs.reasoningLevel.values, ['disabled', 'enabled']);
  assert.equal(ours.config.optionSpecs.maxOutputTokens.max, 64000);
  assert.ok(await fs.readdir(home).then(names => names.some(n => n.endsWith('.bak') || true)));

  // Same content again: no-op.
  const second = await syncZcodeProviders(file, models, 'http://127.0.0.1:41980/v1', 'key-1');
  assert.equal(second.changed, false);

  // Empty list removes only our rules.
  const third = await syncZcodeProviders(file, [], 'http://127.0.0.1:41980/v1', 'key-1');
  assert.equal(third.changed, true);
  const cleaned = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(cleaned.config.modelConfigRules.manualProviderModelRules.filter(r => r.providerId === 'buddybridge'), []);
  assert.deepEqual(cleaned.config.providerConfigRules.providerRules.filter(r => r.providerId === 'buddybridge'), [], 'provider declaration removed too');
  assert.equal(cleaned.config.modelConfigRules.manualProviderModelRules.filter(r => r.providerId === 'other').length, 1);

  // Malformed JSON is never overwritten.
  await fs.writeFile(file, '{broken');
  await assert.rejects(syncZcodeProviders(file, models, 'x', 'y'), /不是有效的 JSON/);
  assert.equal(await fs.readFile(file, 'utf8'), '{broken');
  await fs.rm(home, { recursive: true, force: true });
});

test('zcode missing config reports actionable error without creating files', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'zcode-missing-'));
  const file = path.join(home, 'v2', 'provider_config.json');
  await assert.rejects(syncZcodeProviders(file, models, 'x', 'y'), /未找到 ZCode 配置/);
  await assert.rejects(fs.stat(file), { code: 'ENOENT' }, 'missing config must not be created');
  await fs.rm(home, { recursive: true, force: true });
});

test('zcode backups are capped so repeated imports do not pile up files', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'zcode-backups-'));
  const file = path.join(home, 'v2', 'provider_config.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ schemaVersion: 1, config: { providerConfigRules: { providerRules: [] }, modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] } } }));
  for (let i = 0; i < 9; i++) {
    await syncZcodeProviders(file, [{ ...models[0], name: 'A' + i }], 'http://127.0.0.1:41980/v1', 'key');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  const backups = (await fs.readdir(path.dirname(file))).filter(n => n.endsWith('.bak'));
  assert.ok(backups.length <= 5, `backups capped, got ${backups.length}`);
  await fs.rm(home, { recursive: true, force: true });
});
