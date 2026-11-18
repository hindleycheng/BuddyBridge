// ZCode (智谱 ZCode 桌面版) personal provider sync. Custom models live in a plain-text JSON
// file (~/.zcode/v2/provider_config.json, hot-reloaded via file watcher) and are declared as
// "manual provider model rules": each entry pins a providerId/modelId pair plus an api block
// pointing at our local OpenAI-compatible endpoint. We own the single providerId
// `buddybridge` and remove only its rules on cleanup — the user's own providers stay untouched.
// Schema reference: D:/Program Files/ZCode/resources/config/provider/zcode-builtin.json
// and the zod schemas in the app bundle (api.type: openai-chat-completions, baseUrl required).
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { atomicWrite } from './sync.js';
import { clientModelID } from './model-status.js';

export const ZCODE_PROVIDER = 'buddybridge';
const SCHEMA_VERSION = 1;

export function zcodeConfigPath(home = process.env.BUDDY_ZCODE_HOME || path.join(os.homedir(), '.zcode')) {
  return path.join(home, 'v2', 'provider_config.json');
}

const contextWindow = model => model.input ?? model.context ?? 128000;
const maxOutput = model => model.output ?? 32768;

// One manual rule per model. Manual rules use a REDUCED properties schema (app zod schema
// `Qt=kt.pick(...)`): only contextWindow, supportsJsonSchemaOutput, supportsNativeWebSearch,
// supportsMidConversationSystem and inputFormat{supportsImage,supportsVideo,supportsPdf} —
// no supportsText/outputFormat/supportsToolCall/requiresMfjsToolSchema there (verified against
// ZCode's own ZodError logs). `map` must be a JSON-string expression; "{}" is the no-op the
// built-in config itself uses.
function manualRule(model) {
  return {
    providerId: ZCODE_PROVIDER,
    modelId: clientModelID(model),
    config: {
      enabled: true,
      properties: {
        contextWindow: contextWindow(model),
        supportsJsonSchemaOutput: false,
        supportsNativeWebSearch: false,
        supportsMidConversationSystem: false,
        inputFormat: {
          supportsImage: model.images === true,
          supportsVideo: false,
          supportsPdf: false,
        },
      },
      optionSpecs: {
        reasoningLevel: model.reasoning === true
          ? { values: ['disabled', 'enabled'], map: '{}' }
          : { values: ['disabled'], map: '{}' },
        maxOutputTokens: { max: maxOutput(model) },
      },
    },
  };
}

function ourRules(document) {
  const rules = document?.config?.modelConfigRules?.manualProviderModelRules;
  return Array.isArray(rules) ? rules : [];
}

// The provider declaration carries the endpoint and the API key; the manual rules only
// describe model capabilities. ZCode rejects unknown keys inside providerRules[].config,
// so a personal provider may only hold api/access (no builtinModelIds — that belongs to
// the built-in template schema).
function providerRule(baseURL, apiKey) {
  return {
    providerId: ZCODE_PROVIDER,
    providerName: 'BuddyBridge (OpenCode Free)',
    config: {
      api: { type: 'openai-chat-completions', baseUrl: baseURL },
      access: { type: 'api-key', apiKey },
    },
  };
}

function ourProviderRules(document) {
  const rules = document?.config?.providerConfigRules?.providerRules;
  return Array.isArray(rules) ? rules : [];
}

function mergeRules(document, models, baseURL, apiKey) {
  const kept = ourRules(document).filter(rule => rule?.providerId !== ZCODE_PROVIDER);
  const keptProviders = ourProviderRules(document).filter(rule => rule?.providerId !== ZCODE_PROVIDER);
  const entries = models.map(manualRule);
  const next = {
    schemaVersion: typeof document?.schemaVersion === 'number' ? document.schemaVersion : SCHEMA_VERSION,
    config: {
      ...(document?.config || {}),
      providerConfigRules: { ...(document?.config?.providerConfigRules || {}), providerRules: [...keptProviders, providerRule(baseURL, apiKey)] },
      modelConfigRules: {
        ...(document?.config?.modelConfigRules || {}),
        manualProviderModelRules: [...kept, ...entries],
      },
    },
  };
  // providerOrder/defaultModelSelection live inside config; keep the user's own entries.
  const order = document?.config?.providerOrder;
  if (Array.isArray(order)) next.config.providerOrder = [...order.filter(id => id !== ZCODE_PROVIDER), ZCODE_PROVIDER];
  const selection = document?.config?.defaultModelSelection;
  if (selection && selection.providerId === ZCODE_PROVIDER) next.config.defaultModelSelection = selection;
  return { document: next, changed: JSON.stringify(next) !== JSON.stringify(document) };
}

function removeRules(document) {
  const kept = ourRules(document).filter(rule => rule?.providerId !== ZCODE_PROVIDER);
  const keptProviders = ourProviderRules(document).filter(rule => rule?.providerId !== ZCODE_PROVIDER);
  const order = document?.config?.providerOrder;
  const nextOrder = Array.isArray(order) ? order.filter(id => id !== ZCODE_PROVIDER) : undefined;
  const selection = document?.config?.defaultModelSelection;
  const changed = kept.length !== ourRules(document).length
    || keptProviders.length !== ourProviderRules(document).length
    || (nextOrder && nextOrder.length !== order.length)
    || (selection && selection.providerId === ZCODE_PROVIDER);
  if (!changed) return { document, changed: false };
  const next = {
    ...document,
    config: {
      ...(document?.config || {}),
      providerConfigRules: { ...(document?.config?.providerConfigRules || {}), providerRules: keptProviders },
      modelConfigRules: { ...(document?.config?.modelConfigRules || {}), manualProviderModelRules: kept },
    },
  };
  if (nextOrder) next.config.providerOrder = nextOrder;
  if (selection && selection.providerId === ZCODE_PROVIDER) delete next.config.defaultModelSelection;
  return { document: next, changed: true };
}

export async function syncZcodeProviders(file, models, baseURL, apiKey) {
  let old = {};
  try { old = JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (e) {
    if (e.code === 'ENOENT') throw new Error('未找到 ZCode 配置（~/.zcode/v2/provider_config.json）；请先安装并启动一次 ZCode');
    throw new Error('ZCode 配置不是有效的 JSON，已中止写入：' + e.message);
  }
  const { document: merged, changed } = models.length ? mergeRules(old, models, baseURL, apiKey) : removeRules(old);
  if (!changed) return { changed: false, count: models.length };
  const backup = `${file}.buddybridge-${Date.now()}.bak`;
  await fs.writeFile(backup, JSON.stringify(old, null, 2), { flag: 'wx' }).catch(e => {
    if (e.code !== 'EEXIST') throw e;
  });
  await atomicWrite(file, JSON.stringify(merged, null, 2) + '\n');
  await pruneBackups(file);
  return { changed: true, count: models.length, backup };
}

// Keep only the most recent backups: repeated imports would otherwise pile up files.
const BACKUP_LIMIT = 5;
async function pruneBackups(file) {
  const dir = path.dirname(file);
  const base = path.basename(file) + '.buddybridge-';
  const names = (await fs.readdir(dir).catch(() => [])).filter(name => name.startsWith(base) && name.endsWith('.bak')).sort();
  for (const name of names.slice(0, Math.max(0, names.length - BACKUP_LIMIT))) {
    await fs.unlink(path.join(dir, name)).catch(() => {});
  }
}

// Best-effort availability probe: the config dir existing means ZCode has been installed and
// run at least once; we still refuse to create a missing file (same policy as the intl target).
export async function zcodeAvailable(file = zcodeConfigPath()) {
  try { await fs.stat(file); return true; } catch { return false; }
}
