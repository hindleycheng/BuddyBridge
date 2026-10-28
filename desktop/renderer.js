const $ = id => document.getElementById(id);
let state = {}, selected = null, pendingAction = false, lastModels = '';
function element(tag, className, text) {
  const el = document.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = text; return el;
}
function waiting(id) { return state.probe?.running && state.probe.pending?.includes(id); }
function label(model) {
  if (waiting(model.id)) return state.probe.current === model.id ? '检测中' : '等待检测';
  if ((state.activity || []).some(a => a.model === model.id)) return '请求中';
  if (state.pendingModels?.includes(model.id)) return '待检测';
  const r = state.modelResults?.[model.id];
  if (state.availableModels?.includes(model.id)) return r?.chatOnly ? '可用 · 仅对话' : '可用';
  return ({ timeout: '检测超时', quota: '额度不足', rate_limit: '请求受限', access: '访问受限' })[r?.category] || (r?.ok === false ? '不可用' : '待检测');
}
function rank(model) { return waiting(model.id) || state.pendingModels?.includes(model.id) ? 1 : state.availableModels?.includes(model.id) ? 0 : state.modelResults?.[model.id]?.ok === false ? 2 : 1; }
function timing(id) {
  const r = state.modelResults?.[id]; if (!Number.isFinite(r?.durationMs)) return '响应耗时 —';
  const duration = r.durationMs < 1000 ? `${r.durationMs} ms` : `${(r.durationMs / 1000).toFixed(1)} 秒`;
  return `最近${r.source === 'probe' ? '检测' : '调用'} · ${r.ok ? '响应' : '失败'}耗时 ${duration}`;
}
function statusPill(model) {
  const cls = state.availableModels?.includes(model.id) && !waiting(model.id) ? 'st-ok' : rank(model) === 2 ? 'st-bad' : 'st-wait';
  return element('span', 'pill ' + cls, label(model));
}
function renderModels() {
  const signature = JSON.stringify([state.models, state.modelResults, state.probe, state.pendingModels, state.availableModels, state.activity, state.excludedModels, state.actionBusy, pendingAction, selected]);
  if (signature === lastModels) return; lastModels = signature;
  const scroll = $('models').scrollTop;
  const focused = document.activeElement?.dataset?.model;
  $('models').replaceChildren();
  const models = [...(state.models || [])].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  for (const model of models) {
    const open = selected === model.id;
    const row = element('div', 'model' + (open ? ' open' : '')); row.dataset.model = model.id;
    const choose = element('input', 'model-check'); choose.type = 'checkbox';
    choose.checked = !!state.availableModels?.includes(model.id) && !(state.excludedModels || []).includes(model.id);
    choose.disabled = !!(pendingAction || state.actionBusy || state.probe?.running || state.configSearch?.running || state.phase !== 'ready' || !state.availableModels?.includes(model.id));
    choose.setAttribute('aria-label', `导入 BB · ${model.name}`);
    choose.onclick = event => event.stopPropagation();
    choose.onchange = () => run('selection', { model: model.id, selected: choose.checked });
    const head = element('button', 'model-head');
    head.setAttribute('aria-expanded', String(open));
    const icon = element('span', 'model-icon'); icon.setAttribute('aria-hidden', 'true');
    icon.append(waiting(model.id) ? element('span', 'spinner') : element('span', '', '◇'));
    const info = element('div', 'model-info'); info.append(element('div', 'model-name', `BB · ${model.name}`));
    const pills = element('div', 'pills');
    if (model.reasoning) pills.append(element('span', 'pill cap-reasoning', '推理'));
    if (model.images) pills.append(element('span', 'pill cap-images', '图片'));
    pills.append(statusPill(model));
    head.append(icon, info, pills, element('span', 'duration', timing(model.id)), element('span', 'chev'));
    head.onclick = () => { selected = open ? null : model.id; renderModels(); };
    const body = element('div', 'model-body');
    if (open) fillDetails(body, model);
    row.append(choose, head, body);
    $('models').append(row);
    if (focused === model.id) head.focus({ preventScroll: true });
  }
  if (!models.length) {
    if (state.phase === 'error') $('models').append(element('p', 'empty', '服务未能启动；点击右上角"重试"，或退出后重新打开。'));
    else for (let i = 0; i < 3; i++) {
      const sk = element('div', 'skeleton');
      sk.append(element('i', 'sk-a'), element('i', 'sk-b'), element('i', 'sk-c'));
      $('models').append(sk);
    }
  }
  $('models').scrollTop = scroll;
}
function fillDetails(body, model) {
  const r = state.modelResults?.[model.id] || {};
  const add = (text, css = '') => body.append(element('p', css, text));
  if (r.chatOnly) add('已自动关闭工具调用；导入后仅支持普通对话。');
  if (Number.isInteger(r.nativeAttempts) && r.nativeAttempts > 0) add(`最近一次调用拦截了 ${r.nativeAttempts} 次本地执行尝试，动作必须由 WorkBuddy 执行。`, 'error-text');
  if (Number.isInteger(r.calls) && r.calls > 0) add(`最近一次调用返回了 ${r.calls} 个动作。`);
  if (r.handoff) add(`最近一次调用把被拦下的本地动作转交成外部 ${r.handoff} 调用。`);
  const repairs = Object.entries(r.repaired ?? {}).filter(([, value]) => value?.ok);
  if (repairs.length) add(`这一轮由格式兜底救回：${repairs.map(([shape, value]) => `${shape === 'action' ? '动作转写' : '信封重排'}（${String(value.model).replace('opencode/', '')}）`).join('、')}。`);
  add(`图片输入：${model.images ? '支持' : '不支持'}`);
  add(`上下文：${model.context ?? '未声明'} · 输入上限：${model.input ?? '未单独声明'} · 输出上限：${model.output ?? '未声明'}`);
  const variants = Object.keys(model.variants || {});
  add(model.reasoning ? `推理：支持 · ${variants.length ? '可选档位：' + variants.join(' / ') : '使用默认模式'}` : '推理：OpenCode 未声明支持');
  if (r.error) add(r.error, 'error-text');
  add('最近更新：' + (r.time ? new Date(r.time).toLocaleString() : '尚未检测'));
}
function render() {
  const busy = pendingAction || state.actionBusy || state.configSearch?.running || state.probe?.running || state.phase !== 'ready';
  for (const id of ['refresh', 'probe', 'import', 'proxy', 'update-runtime']) $(id).disabled = !!busy;
  $('restart').hidden = state.phase !== 'error';
  $('restart').disabled = !!(pendingAction || state.actionBusy);
  $('proxy').disabled = !!(pendingAction || state.actionBusy || state.configSearch?.running || state.probe?.running || !['ready', 'error'].includes(state.phase));
  $('proxy').checked = state.useSystemProxy === true;
  if (document.activeElement !== $('gateway-ips')) $('gateway-ips').value = (state.gatewayIPs || []).join(', ');
  $('cache-hours').value = String(state.cacheHours || 8);
  $('service-text').textContent = window.OWActivity.activityText(state.activity?.[0]) || state.message || '正在启动隔离模型服务';
  $('service-dot').className = 'dot' + (state.phase === 'error' ? ' error' : '');
  $('app-version').textContent = state.appVersion ? `BuddyBridge v${state.appVersion}` : 'BuddyBridge';
  $('discovered').textContent = state.models?.length || 0;
  $('available').textContent = state.availableModels?.length || 0;
  $('pending').textContent = state.models?.filter(m => rank(m) === 1).length || 0;
  for (const [id, title, active] of [['update-runtime', '更新 OpenCode', state.actionBusy === 'update-runtime'], ['refresh', '读取免费模型', state.actionBusy === 'refresh'], ['probe', '检测全部', state.probe?.running], ['import', '导入 WorkBuddy', state.actionBusy === 'import']]) {
    $(id).replaceChildren(); if (active) $(id).append(element('span', 'spinner'));
    $(id).append(document.createTextNode(active ? id === 'update-runtime' ? '正在更新…' : id === 'import' ? '正在导入…' : id === 'refresh' ? '正在读取…' : '正在检测…' : title));
  }
  const sync = state.sync;
  const base = (state.configSearch?.running ? 'OpenCode 正在只读查找 WorkBuddy 配置…' : state.configSearch?.candidates?.length > 1 && !state.modelsFile ? '已找到配置文件，点击导入 WorkBuddy 使用最近访问的一份。' : '') || sync?.error || (sync?.time ? `已导入 ${sync.count ?? 0} 个模型 · 再次检测后需点击导入 WorkBuddy 更新` : '启动时仅导入有效缓存；检测后需手动导入 WorkBuddy');
  $('sync').textContent = base + (state.dsh?.available ? ` · DSH ${state.dsh.sync?.error ? '同步失败' : `${state.dsh.sync?.count ?? 0} 个模型`}` : '');
  renderModels();
}
async function run(name, value) {
  if (pendingAction) return; pendingAction = true; $('feedback').hidden = true; render();
  try {
    const response = await window.buddy.action(name, value);
    if (!response.ok) throw new Error(response.error);
    if (name === 'probe' && response.result.canceled) feedback('已取消检测，继续冷却。');
    if (name === 'probe' && response.result.message) feedback(response.result.message);
    if (name === 'update-runtime') feedback(response.result.changed ? `OpenCode 已更新至 ${response.result.version}，仅检测需要更新结果的模型。` : `OpenCode ${response.result.version} 已是最新，无需更新。`);
    if (name === 'selection') { state.excludedModels = response.result.excludedModels; feedback('选择已保存，点击导入 WorkBuddy 后生效。'); }
    if (name === 'prefs') {
      state.gatewayIPs = response.result.gatewayIPs; state.cacheHours = response.result.cacheHours;
      $('gateway-ips').value = (state.gatewayIPs || []).join(', ');
      feedback(state.gatewayIPs?.length ? `设置已保存：优选 IP ${state.gatewayIPs.join('、')}（直连已启用，服务重启中）` : '设置已保存：已清除优选 IP，恢复自动链路。');
    }
    if (name === 'import') {
      const r = response.result;
      if (r.canceled) { feedback('已取消导入，配置未更改。'); return; }
      const dshNote = r.dsh ? (r.dsh.error ? `；DeepSeek Harness 同步失败：${r.dsh.error}` : `；DeepSeek Harness 已同步 ${r.dsh.count} 个模型（DSH 内即可选择）`) : '';
      feedback((r.changed === false ? `配置已是最新，共 ${r.count} 个模型，无需重复写入。` : `导入完成，已将 ${r.count} 个可用模型导入 WorkBuddy。`) + dshNote);
    }
  } catch (error) { feedback(error.message, true); }
  finally { pendingAction = false; render(); }
}
function feedback(text, error = false) { $('feedback').textContent = text; $('feedback').className = error ? 'error' : ''; $('feedback').hidden = false; }
for (const action of ['refresh', 'probe', 'import', 'restart', 'update-runtime']) $(action).onclick = () => run(action);
$('proxy').onchange = () => run('system-proxy', $('proxy').checked);
$('gateway-ips').addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });
$('gateway-ips').onchange = () => run('prefs', { gatewayIPs: $('gateway-ips').value });
$('cache-hours').onchange = () => run('prefs', { cacheHours: Number($('cache-hours').value) });
$('check-update').onclick = () => { $('check-update').disabled = true; window.buddy.checkUpdate().catch(() => {}).finally(() => { $('check-update').disabled = false; }); };
$('contact-card').onclick = () => { $('card-overlay').hidden = false; };
$('card-overlay').onclick = () => { $('card-overlay').hidden = true; };
function dismiss() { selected = null; $('card-overlay').hidden = true; renderModels(); }
document.addEventListener('click', e => { if (!e.target.closest('.model') && !e.target.closest('#contact-card')) { selected = null; renderModels(); } });
document.addEventListener('keydown', e => { if (e.key === 'Escape') dismiss(); });
window.buddy.onDismiss(dismiss);
window.buddy.onState(next => { state = next; render(); });
render();
