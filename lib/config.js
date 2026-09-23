'use strict';

const fs = require('fs');
const path = require('path');

const { dataPath } = require('./paths');

const CONFIG_PATH = dataPath('config.json');

const DEFAULTS = {
  port: 3000,
  // 127.0.0.1 = このPCのみ / 0.0.0.0 = 同じネットワークの他端末（タブレット等）からも操作可
  host: '127.0.0.1',
  youtube: {
    // 'web' = YouTube から直接取得（API の上限なし） / 'api' = YouTube Data API
    source: 'web',
    apiKey: '',
    video: '',
    // 取得・表示するコメントの種類（組み合わせ自由）
    // superchat = スーパーチャット／ステッカー、member = メンバーのコメント、normal = それ以外の通常コメント
    categories: { superchat: true, member: false, normal: false },
    // 'auto' = 1日のクォータを配信時間に均等に割り振る / 'fixed' = minIntervalMs ごと
    pacing: 'auto',
    minIntervalMs: 5000,
    dailyQuota: 10000,
    skipBacklog: true,
  },
  singular: {
    appToken: '',
    // 初期値は Singular の「スーパーチャット」コンポジション（superchat サブコンポジション）に合わせている
    subCompositionName: 'superchat',
    fields: {
      name: 'name',
      amount: 'price',
      comment: 'text',
      icon: '',
      color: 'price_color',
    },
    autoSend: true,
    // チャンネル独自の絵文字（:_name:）を CG に送るとき 'remove' = 取り除く / 'keep' = そのまま
    customEmoji: 'remove',
    // 表示中に次を出すとき、Out せず内容だけ送り直す（テンプレートの更新アニメ）
    swapInPlace: true,
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
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    // 旧設定（mode: 'all' = 全コメント）からの引き継ぎ
    if (raw.youtube && !raw.youtube.categories && raw.youtube.mode === 'all') {
      raw.youtube.categories = { superchat: true, member: true, normal: true };
    }
    return merge(DEFAULTS, raw);
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn(`[config] ${CONFIG_PATH} の読み込みに失敗しました: ${e.message}`);
    return merge(DEFAULTS, {});
  }
}

function save(settings) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(settings, null, 2), 'utf8');
}

// コメントの種類。メンバーのスパチャはスパチャとして扱う
function categoryOf(msg) {
  if (msg.type !== 'text') return 'superchat';
  return msg.isMember ? 'member' : 'normal';
}

module.exports = { categoryOf, load, save, merge, DEFAULTS, CONFIG_PATH };
