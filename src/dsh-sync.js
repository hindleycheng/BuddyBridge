// DeepSeek Harness (DSH) provider sync. DSH keeps custom model providers in a plain-text
// YAML patch layer ($DSH_HOME/profiles/<profile>/cordis.patch.yml, hot-reloaded on the next
// request) and API keys in $DSH_HOME/.credentials.yaml under refs:. We own exactly one
// provider id (`buddybridge`) and one credential ref, so import is a block replace and
// cleanup removes only our block — the user's own providers stay untouched.
import { clientModelID } from './model-status.js';
import { atomicWrite } from './sync.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const ENTRY_ID = 'llm-pi-ai';
const ENTRY_NAME = '@deepseek-ai/dsh-llm-pi-ai';
export const DSH_PROVIDER = 'buddybridge';
export const DSH_API_KEY_ENV = 'BUDDY_BRIDGE_API_KEY';

export function dshPaths(home = process.env.BUDDY_DSH_HOME || path.join(os.homedir(), '.dsh'), profile = process.env.BUDDY_DSH_PROFILE || 'desktop') {
  return { home, profile, patch: path.join(home, 'profiles', profile, 'cordis.patch.yml'), credentials: path.join(home, '.credentials.yaml') };
}

const quote = value => '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';

export function dshModelEntry(model) {
  const id = clientModelID(model);
  return {
    id, name: id,
    ...((model.input ?? model.context) ? { contextWindow: model.input ?? model.context } : {}),
    ...(model.output ? { maxTokens: model.output } : {}),
    input: model.images === true ? ['text', 'image'] : ['text'],
  };
}

export function buildProviderBlock(models, baseURL) {
  const lines = [
    `      ${DSH_PROVIDER}:`,
    '        api: openai-completions',
    `        baseURL: ${baseURL}`,
    `        apiKeyEnv: ${DSH_API_KEY_ENV}`,
    '        models:',
  ];
  for (const model of models) {
    const entry = dshModelEntry(model);
    lines.push(`          - id: ${quote(entry.id)}`);
    lines.push(`            name: ${quote(entry.name)}`);
    if (entry.contextWindow) lines.push(`            contextWindow: ${entry.contextWindow}`);
    if (entry.maxTokens) lines.push(`            maxTokens: ${entry.maxTokens}`);
    lines.push('            input:');
    for (const item of entry.input) lines.push(`              - ${item}`);
  }
  return lines;
}

// Locate the `- id: llm-pi-ai` patch entry and its `providers:` mapping (4-space indent);
// provider children live at 6 spaces, model list items at 10.
function locate(lines) {
  const entryStart = lines.findIndex(line => /^- id: llm-pi-ai\s*$/.test(line));
  if (entryStart === -1) return null;
  let entryEnd = lines.length;
  for (let i = entryStart + 1; i < lines.length; i++) if (/^- /.test(lines[i])) { entryEnd = i; break; }
  let providersLine = -1;
  for (let i = entryStart + 1; i < entryEnd; i++) if (/^ {4}providers:\s*$/.test(lines[i])) { providersLine = i; break; }
  if (providersLine === -1) return { entryStart, entryEnd, providersLine: null };
  let providersEnd = entryEnd;
  for (let i = providersLine + 1; i < entryEnd; i++) {
    const line = lines[i];
    if (line.trim() && !/^ {6}/.test(line) && !/^\s*#/.test(line)) { providersEnd = i; break; }
  }
  let providerStart = -1;
  for (let i = providersLine + 1; i < providersEnd; i++) if (new RegExp(`^ {6}${DSH_PROVIDER}:\\s*$`).test(lines[i])) { providerStart = i; break; }
  let providerEnd = providersEnd;
  if (providerStart !== -1) for (let i = providerStart + 1; i < providersEnd; i++) if (/^ {6}\S/.test(lines[i])) { providerEnd = i; break; }
  const hasOtherProviders = lines.slice(providersLine + 1, providersEnd).some(line => /^ {6}\S/.test(line) && !new RegExp(`^ {6}${DSH_PROVIDER}:\\s*$`).test(line));
  return { entryStart, entryEnd, providersLine, providersEnd, providerStart, providerEnd, hasOtherProviders };
}

export function mergePatchYaml(text, blockLines) {
  const lines = text.split('\n');
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  text = lines.join('\n');
  const found = locate(lines);
  if (!found) {
    const out = [...lines, ...(lines.length ? [''] : []),
      `- id: ${ENTRY_ID}`, `  name: ${quote(ENTRY_NAME)}`, '  config:', '    providers:', ...blockLines];
    return { text: out.join('\n'), changed: true, appended: true };
  }
  if (found.providersLine === null) {
    const insertAt = found.entryEnd;
    const out = [...lines.slice(0, insertAt), '  config:', '    providers:', ...blockLines, ...lines.slice(insertAt)];
    return { text: out.join('\n'), changed: true };
  }
  if (found.providerStart !== -1) {
    const out = [...lines.slice(0, found.providerStart), ...blockLines, ...lines.slice(found.providerEnd)];
    const merged = out.join('\n');
    return { text: merged, changed: merged !== text };
  }
  const out = [...lines.slice(0, found.providersEnd), ...blockLines, ...lines.slice(found.providersEnd)];
  return { text: out.join('\n'), changed: true };
}

export function removePatchEntry(text) {
  const lines = text.split('\n');
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  text = lines.join('\n');
  const found = locate(lines);
  if (!found || found.providersLine === null || found.providerStart === -1) return { text, changed: false };
  let out;
  if (found.hasOtherProviders) {
    out = [...lines.slice(0, found.providerStart), ...lines.slice(found.providerEnd)];
  } else {
    // Our block was the only provider: drop the providers mapping too, and the whole entry
    // when nothing else remains besides its id/name/config header.
    const entryLines = lines.slice(found.entryStart, found.entryEnd)
      .filter((line, index) => index !== found.providersLine - found.entryStart
        && !(index >= found.providerStart - found.entryStart && index < found.providerEnd - found.entryStart));
    const entryHasContent = entryLines.some((line, index) => index > 0 && line.trim() && !/^ {2}(id|name):/.test(line) && line !== '  config:');
    out = entryHasContent
      ? [...lines.slice(0, found.entryStart), ...entryLines, ...lines.slice(found.entryEnd)]
      : [...lines.slice(0, found.entryStart), ...lines.slice(found.entryEnd)];
  }
  const merged = out.join('\n');
  return { text: merged, changed: merged !== text };
}

const credentialLine = apiKey => `  ${DSH_API_KEY_ENV}: ${apiKey}`;

function locateRef(lines) {
  let refsLine = -1;
  for (let i = 0; i < lines.length; i++) if (/^refs:\s*$/.test(lines[i])) { refsLine = i; break; }
  if (refsLine === -1) return null;
  let refsEnd = lines.length;
  for (let i = refsLine + 1; i < lines.length; i++) if (lines[i].trim() && /^\S/.test(lines[i])) { refsEnd = i; break; }
  for (let i = refsLine + 1; i < refsEnd; i++) if (new RegExp(`^  ${DSH_API_KEY_ENV}: `).test(lines[i])) return { refsLine, refsEnd, own: i };
  return { refsLine, refsEnd, own: -1 };
}

export function mergeCredentials(text, apiKey) {
  const lines = text.split('\n');
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  text = lines.join('\n');
  const found = locateRef(lines);
  const wanted = credentialLine(apiKey);
  if (!found) {
    const out = [...lines, ...(lines.length ? [''] : []), 'refs:', wanted];
    return { text: out.join('\n'), changed: true };
  }
  if (found.own !== -1) {
    if (lines[found.own] === wanted) return { text, changed: false };
    const out = [...lines.slice(0, found.own), wanted, ...lines.slice(found.own + 1)];
    return { text: out.join('\n'), changed: true };
  }
  const out = [...lines.slice(0, found.refsEnd), wanted, ...lines.slice(found.refsEnd)];
  return { text: out.join('\n'), changed: true };
}

export function removeCredential(text) {
  const lines = text.split('\n');
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  text = lines.join('\n');
  const found = locateRef(lines);
  if (!found || found.own === -1) return { text, changed: false };
  const hasOtherRefs = lines.slice(found.refsLine + 1, found.refsEnd).some((line, index) => found.refsLine + 1 + index !== found.own && /^\s{2,}\S/.test(line));
  const withoutLine = [...lines.slice(0, found.own), ...lines.slice(found.own + 1)];
  const out = hasOtherRefs ? withoutLine : withoutLine.filter((line, index) => index !== found.refsLine);
  const merged = out.join('\n');
  return { text: merged, changed: merged !== text };
}

const withTrailingNewline = text => text.replace(/\s+$/, '') + '\n';

export async function syncDshProvider(dsh, models, baseURL, apiKey) {
  const oldPatch = await fs.readFile(dsh.patch, 'utf8')
    .catch(() => { throw new Error('未找到 DeepSeek Harness 配置（~/.dsh/profiles/*/cordis.patch.yml）；请先安装并启动一次 DSH'); });
  const oldCredentials = await fs.readFile(dsh.credentials, 'utf8').catch(() => null);
  const patch = models.length ? mergePatchYaml(oldPatch, buildProviderBlock(models, baseURL)) : removePatchEntry(oldPatch);
  const credentials = models.length
    ? (oldCredentials === null ? { text: `version: 1\nrefs:\n${credentialLine(apiKey)}\n`, changed: true } : mergeCredentials(oldCredentials, apiKey))
    : (oldCredentials === null ? { changed: false } : removeCredential(oldCredentials));
  if (!patch.changed && !credentials.changed) return { changed: false, count: models.length };
  const backup = `${dsh.patch}.buddybridge-${Date.now()}.bak`;
  await fs.writeFile(backup, oldPatch, { mode: 0o600, flag: 'wx' });
  if (patch.changed) await atomicWrite(dsh.patch, withTrailingNewline(patch.text));
  if (credentials.changed && credentials.text !== undefined) await atomicWrite(dsh.credentials, withTrailingNewline(credentials.text));
  return { changed: true, count: models.length, backup };
}
