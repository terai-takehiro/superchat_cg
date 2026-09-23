'use strict';

// YouTube Data API を使わず、YouTube のライブチャット（ブラウザと同じ仕組み）から直接取得する。
// API の1日の上限がないので長時間配信向け。ただし YouTube 側の仕様変更で動かなくなる可能性がある。
const { EventEmitter } = require('events');
const { extractVideoId, tierColors } = require('./youtube');

const ORIGIN = 'https://www.youtube.com';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  'Accept-Language': 'ja,en;q=0.8',
  Cookie: 'CONSENT=YES+cb; PREF=hl=ja&gl=JP',
};

// HTML 中の `ytInitialData = {...};` などから JSON を取り出す（文字列内の括弧も考慮）
function extractJson(html, marker) {
  const at = html.indexOf(marker);
  if (at < 0) return null;
  const start = html.indexOf('{', at + marker.length);
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try {
        return JSON.parse(html.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function runsToText(runs) {
  return (runs || [])
    .map((r) => {
      if (r.text != null) return r.text;
      const e = r.emoji;
      if (!e) return '';
      // 標準の絵文字は emojiId が文字そのもの、カスタム絵文字は :_name: 形式
      return e.isCustomEmoji ? e.shortcuts?.[0] || '' : e.emojiId || e.shortcuts?.[0] || '';
    })
    .join('');
}

const argbToHex = (n) => (typeof n === 'number' ? `#${(n & 0xffffff).toString(16).padStart(6, '0')}` : null);

// "¥1,000" / "￥1,000" / "$5.00" などから通貨と金額（micros）を推定
function parseAmount(text) {
  const s = String(text || '').trim();
  const num = Number(s.replace(/[^\d.]/g, '')) || 0;
  const currency = /^[¥￥]|円/.test(s) ? 'JPY' : /^\$/.test(s) ? 'USD' : '';
  return { currency, amountMicros: Math.round(num * 1e6) };
}

function parseItem(item) {
  const [kind, r] = Object.entries(item || {})[0] || [];
  if (!r) return null;
  const badges = (r.authorBadges || []).map((b) => b.liveChatAuthorBadgeRenderer || {});
  const base = {
    id: r.id,
    type: 'text',
    name: r.authorName?.simpleText || '',
    channelId: r.authorExternalChannelId || '',
    icon: r.authorPhoto?.thumbnails?.at(-1)?.url || '',
    isMember: badges.some((b) => b.customThumbnail),
    isModerator: badges.some((b) => b.icon?.iconType === 'MODERATOR'),
    isOwner: badges.some((b) => b.icon?.iconType === 'OWNER'),
    amount: '',
    amountMicros: 0,
    currency: '',
    tier: null,
    comment: runsToText(r.message?.runs),
    publishedAt: r.timestampUsec ? new Date(Number(r.timestampUsec) / 1000).toISOString() : new Date().toISOString(),
  };

  switch (kind) {
    case 'liveChatTextMessageRenderer':
      return base;
    case 'liveChatPaidMessageRenderer': {
      const amount = r.purchaseAmountText?.simpleText || '';
      const msg = { ...base, type: 'superchat', amount, ...parseAmount(amount) };
      const header = argbToHex(r.headerBackgroundColor);
      msg.colors = header
        ? { header, body: argbToHex(r.bodyBackgroundColor) || header, text: argbToHex(r.headerTextColor) || '#ffffff' }
        : tierColors(msg);
      return msg;
    }
    case 'liveChatPaidStickerRenderer': {
      const amount = r.purchaseAmountText?.simpleText || '';
      const msg = {
        ...base,
        type: 'supersticker',
        amount,
        ...parseAmount(amount),
        comment: r.sticker?.accessibility?.accessibilityData?.label || '',
      };
      const header = argbToHex(r.moneyChipBackgroundColor) || argbToHex(r.backgroundColor);
      msg.colors = header
        ? { header, body: argbToHex(r.backgroundColor) || header, text: argbToHex(r.moneyChipTextColor) || '#ffffff' }
        : tierColors(msg);
      return msg;
    }
    default:
      // メンバー加入・システムメッセージなどは対象外
      return null;
  }
}

function pickContinuation(c) {
  const d = c?.invalidationContinuationData || c?.timedContinuationData || c?.reloadContinuationData;
  return d ? { continuation: d.continuation, timeoutMs: Number(d.timeoutMs) || 0 } : null;
}

async function fetchChatPage(videoId) {
  const res = await fetch(`${ORIGIN}/live_chat?v=${encodeURIComponent(videoId)}&is_popout=1`, { headers: HEADERS });
  if (!res.ok) throw Object.assign(new Error(`YouTube に接続できません (${res.status})`), { status: res.status });
  const html = await res.text();
  const apiKey = html.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/)?.[1] || '';
  const clientVersion = html.match(/"INNERTUBE_CONTEXT_CLIENT_VERSION"\s*:\s*"([^"]+)"/)?.[1]
    || html.match(/"clientVersion"\s*:\s*"([^"]+)"/)?.[1] || '2.20240101.00.00';
  const data = extractJson(html, 'ytInitialData');
  const lcr = data?.contents?.liveChatRenderer;
  if (!lcr) throw new Error('ライブチャットが見つかりません（配信中か、チャットが有効か確認してください）');

  // 「上位のチャット」ではなく「チャット（すべて）」を選ぶ（通常は2番目の項目）
  const items = lcr.header?.liveChatHeaderRenderer?.viewSelector?.sortFilterSubMenuRenderer?.subMenuItems || [];
  const all = pickContinuation(items.at(-1)?.continuation);
  const first = pickContinuation(lcr.continuations?.[0]);
  const cont = all || first;
  if (!cont) throw new Error('チャットの取得位置が見つかりません（配信が終了している可能性があります）');
  return { apiKey, clientVersion, continuation: cont.continuation, initialActions: all ? [] : lcr.actions || [] };
}

async function fetchTitle(videoId) {
  try {
    const url = `${ORIGIN}/oembed?format=json&url=${encodeURIComponent(`${ORIGIN}/watch?v=${videoId}`)}`;
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) return {};
    const j = await res.json();
    return { title: j.title || '', channelTitle: j.author_name || '' };
  } catch {
    return {};
  }
}

class YouTubeWebChat extends EventEmitter {
  constructor() {
    super();
    this.running = false;
    this.gen = 0;
    this.timer = null;
    this.info = null;
    this.lastError = '';
    this.errorCount = 0;
    this.seen = new Set();
    this.intervalMs = 0;
  }

  status() {
    return {
      running: this.running,
      source: 'web',
      videoId: this.info?.videoId || '',
      title: this.info?.title || '',
      channelTitle: this.info?.channelTitle || '',
      lastError: this.lastError,
      intervalMs: this.running ? this.intervalMs : 0,
      pausedUntil: 0,
      quotaUsed: 0,
      dailyQuota: 0,
      resetAt: 0,
    };
  }

  async start({ video, skipBacklog }) {
    this.stop();
    const videoId = extractVideoId(video);
    if (!videoId) throw new Error('動画 ID または URL が正しくありません');
    const [page, meta] = await Promise.all([fetchChatPage(videoId), fetchTitle(videoId)]);

    this.gen += 1;
    this.running = true;
    this.lastError = '';
    this.errorCount = 0;
    // 同じ配信への再接続なら取り込み済みの記録を残し、二重に取り込まないようにする
    if (this.info?.videoId !== videoId) this.seen.clear();
    this.info = { videoId, title: meta.title || videoId, channelTitle: meta.channelTitle || '', ...page, first: Boolean(skipBacklog) };
    this._handleActions(page.initialActions);
    this.emit('status', this.status());
    this._poll(this.gen);
  }

  updateOptions() {}

  stop(reason = '') {
    const wasRunning = this.running;
    this.gen += 1;
    this.running = false;
    clearTimeout(this.timer);
    this.timer = null;
    if (reason) this.lastError = reason;
    if (wasRunning || reason) this.emit('status', this.status());
  }

  _handleActions(actions) {
    const skip = this.info.first;
    for (const a of actions || []) {
      const item = a.addChatItemAction?.item;
      if (!item) continue;
      const msg = parseItem(item);
      if (!msg?.id || this.seen.has(msg.id)) continue;
      this.seen.add(msg.id);
      if (!skip) this.emit('message', msg);
    }
    if (this.seen.size > 20000) this.seen = new Set([...this.seen].slice(-5000));
  }

  _schedule(gen, wait) {
    this.intervalMs = wait;
    this.emit('status', this.status());
    this.timer = setTimeout(() => this._poll(gen), wait);
  }

  async _poll(gen) {
    if (!this.running || gen !== this.gen) return;
    const info = this.info;
    let wait;
    try {
      const res = await fetch(`${ORIGIN}/youtubei/v1/live_chat/get_live_chat?prettyPrint=false${info.apiKey ? `&key=${info.apiKey}` : ''}`, {
        method: 'POST',
        headers: { ...HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          context: { client: { clientName: 'WEB', clientVersion: info.clientVersion, hl: 'ja', gl: 'JP' } },
          continuation: info.continuation,
        }),
      });
      if (gen !== this.gen) return;
      if (!res.ok) throw Object.assign(new Error(`YouTube の応答エラー (${res.status})`), { status: res.status });
      const data = await res.json();
      const lcc = data.continuationContents?.liveChatContinuation;
      const next = pickContinuation(lcc?.continuations?.[0]);
      if (!lcc || !next) {
        // 一時的な応答の可能性があるので、チャットページを読み直して続けられるか確認する
        try {
          const page = await fetchChatPage(info.videoId);
          if (gen !== this.gen) return;
          Object.assign(info, { apiKey: page.apiKey, clientVersion: page.clientVersion, continuation: page.continuation });
          this._schedule(gen, 5000);
        } catch {
          if (gen !== this.gen) return;
          this.stop('配信が終了したか、チャットが閉じられました');
        }
        return;
      }
      this._handleActions(lcc.actions);
      info.first = false;
      info.continuation = next.continuation;
      this.errorCount = 0;
      this.lastError = '';
      wait = Math.min(10000, Math.max(1000, next.timeoutMs || 5000));
    } catch (e) {
      if (gen !== this.gen) return;
      this.errorCount += 1;
      this.lastError = e.message;
      // 取得位置が古くなった可能性があるので、数回失敗したらチャットページから取り直す
      if (this.errorCount % 3 === 0) {
        try {
          const page = await fetchChatPage(info.videoId);
          if (gen !== this.gen) return;
          Object.assign(info, { apiKey: page.apiKey, clientVersion: page.clientVersion, continuation: page.continuation });
        } catch (e2) {
          if (gen !== this.gen) return;
          this.lastError = e2.message;
        }
      }
      // 長時間配信でも止めずに、間隔を延ばしながら再試行し続ける
      wait = Math.min(60000, 2000 * 2 ** Math.min(this.errorCount, 5));
    }
    if (this.running && gen === this.gen) this._schedule(gen, wait);
  }
}

module.exports = { YouTubeWebChat, parseItem, extractJson, runsToText, parseAmount };
