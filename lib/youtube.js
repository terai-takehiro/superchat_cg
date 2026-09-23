'use strict';

const { EventEmitter } = require('events');

const API = 'https://www.googleapis.com/youtube/v3';

// 再試行しても直らないエラー（キー不正・クォータ超過・チャット終了など）
const RETRYABLE_REASONS = new Set(['rateLimitExceeded', 'backendError', 'internalError']);

function extractVideoId(input) {
  const s = String(input || '').trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s);
    if (u.hostname.endsWith('youtu.be')) {
      const id = u.pathname.slice(1, 12);
      return /^[\w-]{11}$/.test(id) ? id : null;
    }
    const v = u.searchParams.get('v');
    if (v && /^[\w-]{11}$/.test(v)) return v;
    const m = u.pathname.match(/\/(?:live|embed|shorts|v)\/([\w-]{11})/);
    if (m) return m[1];
  } catch {
    // URL ではない
  }
  return null;
}

async function ytGet(resource, params) {
  const url = new URL(`${API}/${resource}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const reason = body?.error?.errors?.[0]?.reason || '';
    const err = new Error(`YouTube API エラー (${res.status}${reason ? ` ${reason}` : ''}): ${body?.error?.message || res.statusText}`);
    err.status = res.status;
    err.reason = reason;
    throw err;
  }
  return body;
}

function normalize(item) {
  const sn = item.snippet || {};
  const au = item.authorDetails || {};
  const base = {
    id: item.id,
    type: 'text',
    name: au.displayName || '',
    channelId: au.channelId || sn.authorChannelId || '',
    icon: au.profileImageUrl || '',
    isMember: Boolean(au.isChatSponsor),
    isModerator: Boolean(au.isChatModerator),
    isOwner: Boolean(au.isChatOwner),
    amount: '',
    amountMicros: 0,
    currency: '',
    tier: null,
    comment: sn.displayMessage || '',
    publishedAt: sn.publishedAt || new Date().toISOString(),
  };

  switch (sn.type) {
    case 'textMessageEvent':
      base.comment = sn.textMessageDetails?.messageText ?? base.comment;
      return base;
    case 'superChatEvent': {
      const d = sn.superChatDetails || {};
      return {
        ...base,
        type: 'superchat',
        amount: d.amountDisplayString || '',
        amountMicros: Number(d.amountMicros) || 0,
        currency: d.currency || '',
        tier: d.tier ?? null,
        comment: d.userComment || '',
      };
    }
    case 'superStickerEvent': {
      const d = sn.superStickerDetails || {};
      return {
        ...base,
        type: 'supersticker',
        amount: d.amountDisplayString || '',
        amountMicros: Number(d.amountMicros) || 0,
        currency: d.currency || '',
        tier: d.tier ?? null,
        comment: d.superStickerMetadata?.altText || '',
      };
    }
    default:
      // メンバー加入・削除イベントなどは対象外
      return null;
  }
}

class YouTubeLiveChat extends EventEmitter {
  constructor() {
    super();
    this.running = false;
    this.gen = 0;
    this.timer = null;
    this.info = null;
    this.lastError = '';
    this.errorCount = 0;
    this.seen = new Set();
  }

  status() {
    return {
      running: this.running,
      videoId: this.info?.videoId || '',
      title: this.info?.title || '',
      channelTitle: this.info?.channelTitle || '',
      lastError: this.lastError,
    };
  }

  async start({ apiKey, video, minIntervalMs, skipBacklog }) {
    this.stop();
    if (!apiKey) throw new Error('YouTube API Key が未設定です');
    const videoId = extractVideoId(video);
    if (!videoId) throw new Error('動画 ID または URL が正しくありません');

    const data = await ytGet('videos', { part: 'liveStreamingDetails,snippet', id: videoId, key: apiKey });
    const item = data.items?.[0];
    if (!item) throw new Error('動画が見つかりません（ID・公開設定を確認してください）');
    const liveChatId = item.liveStreamingDetails?.activeLiveChatId;
    if (!liveChatId) throw new Error('アクティブなライブチャットがありません（配信中・チャット有効か確認してください）');

    this.gen += 1;
    this.running = true;
    this.lastError = '';
    this.errorCount = 0;
    this.seen.clear();
    this.info = {
      videoId,
      title: item.snippet?.title || '',
      channelTitle: item.snippet?.channelTitle || '',
      liveChatId,
      apiKey,
      minIntervalMs: Math.max(1000, Number(minIntervalMs) || 5000),
      pageToken: null,
      first: Boolean(skipBacklog),
    };
    this.emit('status', this.status());
    this._poll(this.gen);
  }

  stop(reason = '') {
    const wasRunning = this.running;
    this.gen += 1;
    this.running = false;
    clearTimeout(this.timer);
    this.timer = null;
    if (reason) this.lastError = reason;
    if (wasRunning || reason) this.emit('status', this.status());
  }

  async _poll(gen) {
    if (!this.running || gen !== this.gen) return;
    const info = this.info;
    let wait = info.minIntervalMs;
    try {
      const data = await ytGet('liveChat/messages', {
        liveChatId: info.liveChatId,
        part: 'snippet,authorDetails',
        maxResults: 2000,
        pageToken: info.pageToken,
        key: info.apiKey,
      });
      if (gen !== this.gen) return;
      info.pageToken = data.nextPageToken || info.pageToken;
      wait = Math.max(Number(data.pollingIntervalMillis) || 0, info.minIntervalMs);

      for (const raw of data.items || []) {
        if (this.seen.has(raw.id)) continue;
        this.seen.add(raw.id);
        if (info.first) continue;
        const msg = normalize(raw);
        if (msg) this.emit('message', msg);
      }
      if (this.seen.size > 20000) this.seen = new Set([...this.seen].slice(-5000));
      info.first = false;

      if (this.errorCount || this.lastError) {
        this.errorCount = 0;
        this.lastError = '';
        this.emit('status', this.status());
      }
      if (data.offlineAt) {
        this.stop('配信が終了しました');
        return;
      }
    } catch (e) {
      if (gen !== this.gen) return;
      const fatal = e.status && e.status >= 400 && e.status < 500 && e.status !== 429 && !RETRYABLE_REASONS.has(e.reason);
      if (fatal) {
        this.stop(e.message);
        return;
      }
      this.errorCount += 1;
      this.lastError = e.message;
      wait = Math.min(60000, info.minIntervalMs * 2 ** Math.min(this.errorCount, 4));
      this.emit('status', this.status());
    }
    if (this.running && gen === this.gen) {
      this.timer = setTimeout(() => this._poll(gen), wait);
    }
  }
}

module.exports = { YouTubeLiveChat, extractVideoId, normalize };
