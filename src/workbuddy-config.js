import fs from 'node:fs/promises';
import { parseJson } from './json.js';
import path from 'node:path';
import os from 'node:os';

export async function validateModelsFile(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || path.basename(file).toLowerCase() !== 'models.json')
    throw new Error('请选择 WorkBuddy 的 models.json 配置文件');
  const document = parseJson(await fs.readFile(file, 'utf8'));
  if (!Array.isArray(document) && !Array.isArray(document?.models))
    throw new Error('文件不是支持的 WorkBuddy 模型配置格式');
  return file;
}

export async function resolveModelsFile({ saved, env = process.env, home = os.homedir() } = {}) {
  // A remembered or explicit location must never silently fall back to another profile.
  const file = env.BUDDY_MODELS_FILE || saved || path.join(env.WORKBUDDY_CONFIG_DIR?.trim() || path.join(home, env.WORKBUDDY_DATA_FOLDER_NAME?.trim() || '.workbuddy'), 'models.json');
  try { return await validateModelsFile(file); } catch { return null; }
}

// WorkBuddy 国际版（WorkBuddy AI）使用独立数据目录 .workbuddy-ai，models.json 格式与国内版一致。
// 只有该文件已经存在（用户安装并至少保存过一个自定义模型）时才纳入随行同步；绝不主动创建。
export async function resolveIntlModelsFile({ env = process.env, home = os.homedir() } = {}) {
  if (env.BUDDY_NO_INTL_SYNC === '1') return null;
  const file = env.BUDDY_INTL_MODELS_FILE?.trim() || path.join(home, '.workbuddy-ai', 'models.json');
  try { return await validateModelsFile(file); } catch { return null; }
}
