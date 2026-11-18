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

function mergeRules(document, models) {
  const kept = ourRules(document).filter(rule => rule?.providerId !== ZCODE_PROVIDER);
  const entries = models.map(manualRule);
  const next = {
    schemaVersion: typeof document?.schemaVersion === 'number' ? document.schemaVersion : SCHEMA_VERSION,
    config: {
      ...(document?.config || {}),
      providerConfigRules: { ...(document?.config?.providerConfigRules || {}), providerRules: document?.config?.providerConfigRules?.providerRules || [] },
      modelConfigRules: {
        ...(document?.config?.modelConfigRules || {}),
        manualProviderModelRules: [...kept, ...entries],
      },
    },
  };
  // providerOrder/defaultModelSelection stay untouched when present.
  if (document?.providerOrder !== undefined) next.providerOrder = document.providerOrder;
  if (document?.defaultModelSelection !== undefined) next.defaultModelSelection = document.defaultModelSelection;
  return { document: next, changed: JSON.stringify(next) !== JSON.stringify(document) };
}

function removeRules(document) {
  const kept = ourRules(document).filter(rule => rule?.providerId !== ZCODE_PROVIDER);
  if (kept.length === ourRules(document).length) return { document, changed: false };
  return {
    document: {
      ...document,
      config: {
        ...(document?.config || {}),
        modelConfigRules: { ...(document?.config?.modelConfigRules || {}), manualProviderModelRules: kept },
      },
    },
    changed: true,
  };
}

export async function syncZcodeProviders(file, models, baseURL, apiKey) {
  let old = {};
  try { old = JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (e) {
    if (e.code === 'ENOENT') throw new Error('未找到 ZCode 配置（~/.zcode/v2/provider_config.json）；请先安装并启动一次 ZCode');
    throw new Error('ZCode 配置不是有效的 JSON，已中止写入：' + e.message);
  }
  const { document: merged, changed } = models.length ? mergeRules(old, models.map(m => ({ ...m, baseURL, apiKey }))) : removeRules(old);
  if (!changed) return { changed: false, count: models.length };
  const backup = `${file}.buddybridge-${Date.now()}.bak`;
  await fs.writeFile(backup, JSON.stringify(old, null, 2), { flag: 'wx' }).catch(e => {
    if (e.code !== 'EEXIST') throw e;
  });
  await atomicWrite(file, JSON.stringify(merged, null, 2) + '\n');
  return { changed: true, count: models.length, backup };
}

// Best-effort availability probe: the config dir existing means ZCode has been installed and
// run at least once; we still refuse to create a missing file (same policy as the intl target).
export async function zcodeAvailable(file = zcodeConfigPath()) {
  try { await fs.stat(file); return true; } catch { return false; }
}
