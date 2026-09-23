'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

const DEFAULTS = {
  port: 3000,
  // 127.0.0.1 = このPCのみ / 0.0.0.0 = 同じネットワークの他端末（タブレット等）からも操作可
  host: '127.0.0.1',
  youtube: {
    apiKey: '',
    video: '',
    // 'superchat' = スーパーチャット（＋スーパーステッカー）のみ / 'all' = 通常コメントも含む
    mode: 'superchat',
    minIntervalMs: 5000,
    skipBacklog: true,
  },
  singular: {
    appToken: '',
    subCompositionName: '',
    fields: {
      name: 'Name',
      amount: 'Amount',
      comment: 'Comment',
      icon: '',
      color: '',
    },
    autoSend: true,
    displaySeconds: 8,
    gapSeconds: 1,
  },
};

function merge(base, override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) return base;
  const out = { ...base };
  for (const key of Object.keys(base)) {
    if (!(key in override)) continue;
    const b = base[key];
    const o = override[key];
    if (b && typeof b === 'object' && !Array.isArray(b)) {
      out[key] = merge(b, o);
    } else if (typeof b === 'number') {
      const n = Number(o);
      if (Number.isFinite(n)) out[key] = n;
    } else if (typeof b === 'boolean') {
      out[key] = Boolean(o);
    } else if (typeof b === 'string') {
      out[key] = o == null ? '' : String(o).trim();
    }
  }
  return out;
}

function load() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    return merge(DEFAULTS, JSON.parse(raw));
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn(`[config] ${CONFIG_PATH} の読み込みに失敗しました: ${e.message}`);
    return merge(DEFAULTS, {});
  }
}

function save(settings) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(settings, null, 2), 'utf8');
}

module.exports = { load, save, merge, DEFAULTS, CONFIG_PATH };
