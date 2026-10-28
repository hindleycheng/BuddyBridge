import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export const PROBE_COOLDOWN = 30 * 60 * 1000;
export const PROBE_CACHE_TTL = 8 * 60 * 60 * 1000;
export const PROBE_INTERVAL = 4000;
export const PROBE_PAUSED = '网关拒绝或限制了请求，已暂停检测；30 分钟内不再自动检测。';

export function modelFingerprint(model) {
  const canonical = value => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  return createHash('sha256').update(JSON.stringify(canonical(model))).digest('hex');
}
export function cachedProbe(model, result, previousModel, now = Date.now(), ttl = PROBE_CACHE_TTL) {
  const age = now - Date.parse(result?.time);
  return result?.ok === true && age >= 0 && age < ttl
    && (result.catalogFingerprint || (previousModel && modelFingerprint(previousModel))) === modelFingerprint(model);
}
export function probeGate(blockedUntil, { manual = false, confirmed = false } = {}, now = Date.now()) {
  if (!(blockedUntil > now)) return null;
  if (manual && confirmed) return null;
  return { started: false, blockedUntil, confirmationRequired: manual, message: PROBE_PAUSED };
}

// A rejected gateway must not receive requests for the remainder of the catalog.
// The callback returns the final error, including a failed chat-only fallback.
// A per-model geo restriction (e.g. "not available in your country") is permanent and
// scoped to that one model: it records a failure but must not pause the whole queue.
export function isModelLevelRejection(error) {
  return error?.status === 403 && error?.code === 'model_error'
    && /not available|unavailable|country|region|国家|地区|区域/i.test(error?.message || '');
}

export async function runProbeQueue(models, { probe, onPending, onBlocked, signal, sleep = delay, random = Math.random }) {
  const pending = models.map(model => model.id);
  onPending([...pending]);
  for (const model of models) {
    if (signal.aborted) break;
    const error = await probe(model);
    pending.shift();
    onPending([...pending]);
    if (signal.aborted) break;
    if ([401, 403, 429].includes(error?.status) && !isModelLevelRejection(error)) {
      await onBlocked(error);
      break;
    }
    if (pending.length) {
      try { await sleep(PROBE_INTERVAL + Math.floor(random() * 1000), undefined, { signal }); }
      catch (error) { if (!signal.aborted) throw error; break; }
    }
  }
}
