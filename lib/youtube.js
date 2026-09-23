'use strict';

const { EventEmitter } = require('events');

const API = 'https://www.googleapis.com/youtube/v3';

// 再試行しても直らないエラー（キー不正・クォータ超過・チャット終了など）
const RETRYABLE_REASONS = new Set(['rateLimitExceeded', 'backendError', 'internalError']);

// YouTube スーパーチャットの金額帯カラー（tier 1〜7、日本円では ¥100 / ¥200 / ¥500 / ¥1,000 / ¥2,000 / ¥5,000 / ¥10,000〜）
const TIER_COLORS = {
  1: { header: '#1565c0', body: '#1e88e5', text: '#ffffff' },
  2: { header: '#00b8d4', body: '#00e5ff', text: '#000000' },
  3: { header: '#00bfa5', body: '#1de9b6', text: '#000000' },
  4: { header: '#ffb300', body: '#ffca28', text: '#000000' },
  5: { header: '#e65100', body: '#f57c00', text: '#ffffff' },
  6: { header: '#c2185b', body: '#e91e63', text: '#ffffff' },
  7: { header: '#d00000', body: '#e62117', text: '#ffffff' },
};
const JPY_TIER_MIN = [0, 200, 500, 1000, 2000, 5000, 10000];

function tierColors(msg) {
  let t = Number(msg.tier) || 0;
  if (msg.currency === 'JPY' && msg.amountMicros) {
    const yen = msg.amountMicros / 1e6;
    t = JPY_TIER_MIN.filter((min) => yen >= min).length;
  }
  return TIER_COLORS[Math.min(Math.max(t, 1), 7)];
}

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

function withColors(msg) {
  return { ...msg, colors: tierColors(msg) };
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
      return withColors({
        ...base,
        type: 'superchat',
        amount: d.amountDisplayString || '',
        amountMicros: Number(d.amountMicros) || 0,
        currency: d.currency || '',
        tier: d.tier ?? null,
        comment: d.userComment || '',
      });
    }
    case 'superStickerEvent': {
      const d = sn.superStickerDetails || {};
      return withColors({
        ...base,
        type: 'supersticker',
        amount: d.amountDisplayString || '',
        amountMicros: Number(d.amountMicros) || 0,
        currency: d.currency || '',
        tier: d.tier ?? null,
        comment: d.superStickerMetadata?.altText || '',
      });
    }
    default:
      // メンバー加入・削除イベントなどは対象外
      return null;
  }
}

const COST_LIST = 5; // liveChatMessages.list 1 回あたりのユニット
const COST_VIDEO = 1; // videos.list
const RESERVE_UNITS = 50; // 再起動などのための予備

class YouTubeLiveChat extends EventEmitter {
  constructor(quota) {
    super();
    this.quota = quota;
    this.running = false;
    this.gen = 0;
    this.timer = null;
    this.info = null;
    this.lastError = '';
    this.errorCount = 0;
    this.seen = new Set();
    this.intervalMs = 0;
    this.pausedUntil = 0;
  }

  status() {
    return {
      running: this.running,
      videoId: this.info?.videoId || '',
      title: this.info?.title || '',
      channelTitle: this.info?.channelTitle || '',
      lastError: this.lastError,
      intervalMs: this.running ? this.intervalMs : 0,
      pausedUntil: this.running ? this.pausedUntil : 0,
      quotaUsed: this.quota.getUsed(),
      dailyQuota: this.info?.dailyQuota || 0,
      resetAt: this.quota.resetAt(),
    };
  }

  async start({ apiKey, video, pacing, minIntervalMs, dailyQuota, skipBacklog }) {
    this.stop();
    if (!apiKey) throw new Error('YouTube API Key が未設定です');
    const videoId = extractVideoId(video);
    if (!videoId) throw new Error('動画 ID または URL が正しくありません');

    this.quota.add(COST_VIDEO);
    const data = await ytGet('videos', { part: 'liveStreamingDetails,snippet', id: videoId, key: apiKey });
    const item = data.items?.[0];
    if (!item) throw new Error('動画が見つかりません（ID・公開設定を確認してください）');
    const liveChatId = item.liveStreamingDetails?.activeLiveChatId;
    if (!liveChatId) throw new Error('アクティブなライブチャットがありません（配信中・チャット有効か確認してください）');

    this.gen += 1;
    this.running = true;
    this.lastError = '';
    this.errorCount = 0;
    this.pausedUntil = 0;
    this.seen.clear();
    this.info = {
      videoId,
      title: item.snippet?.title || '',
      channelTitle: item.snippet?.channelTitle || '',
      liveChatId,
      apiKey,
      pacing: pacing === 'fixed' ? 'fixed' : 'auto',
      minIntervalMs: Math.max(1000, Number(minIntervalMs) || 5000),
      dailyQuota: Math.max(100, Number(dailyQuota) || 10000),
      pageToken: null,
      first: Boolean(skipBacklog),
    };
    this.emit('status', this.status());
    this._poll(this.gen);
  }

  // 設定変更（取得間隔・クォータ）を取得中にも反映する
  updateOptions({ pacing, minIntervalMs, dailyQuota }) {
    if (!this.info) return;
    this.info.pacing = pacing === 'fixed' ? 'fixed' : 'auto';
    this.info.minIntervalMs = Math.max(1000, Number(minIntervalMs) || 5000);
    this.info.dailyQuota = Math.max(100, Number(dailyQuota) || 10000);
    if (this.running) this.emit('status', this.status());
  }

  stop(reason = '') {
    const wasRunning = this.running;
    this.gen += 1;
    this.running = false;
    this.pausedUntil = 0;
    clearTimeout(this.timer);
    this.timer = null;
    if (reason) this.lastError = reason;
    if (wasRunning || reason) this.emit('status', this.status());
  }

  // 次の取得までの待ち時間。自動のときは、リセットまでに残りのユニットを使い切らないよう均等に割り振る
  _nextWait(apiMinMs) {
    const info = this.info;
    const floor = Math.max(1000, apiMinMs || 0);
    if (info.pacing === 'fixed') return Math.max(floor, info.minIntervalMs);
    const left = info.dailyQuota - this.quota.getUsed() - RESERVE_UNITS;
    const calls = Math.floor(left / COST_LIST);
    const untilReset = this.quota.resetAt() - Date.now();
    if (calls <= 0) return untilReset + 60000;
    return Math.max(floor, Math.ceil(untilReset / calls));
  }

  _schedule(gen, wait) {
    this.intervalMs = wait;
    // クォータ切れで長く待つ場合は「休止中」として表示
    this.pausedUntil = wait > 10 * 60000 ? Date.now() + wait : 0;
    this.emit('status', this.status());
    this.timer = setTimeout(() => this._poll(gen), wait);
  }

  async _poll(gen) {
    if (!this.running || gen !== this.gen) return;
    const info = this.info;
    let wait;
    try {
      this.quota.add(COST_LIST);
      const data = await ytGet('liveChat/messages', {
        liveChatId: info.liveChatId,
        part: 'snippet,authorDetails',
        maxResults: 2000,
        pageToken: info.pageToken,
        key: info.apiKey,
      });
      if (gen !== this.gen) return;
      info.pageToken = data.nextPageToken || info.pageToken;

      const items = data.items || [];
      for (const raw of items) {
        if (this.seen.has(raw.id)) continue;
        this.seen.add(raw.id);
        if (info.first) continue;
        const msg = normalize(raw);
        if (msg) this.emit('message', msg);
      }
      if (this.seen.size > 20000) this.seen = new Set([...this.seen].slice(-5000));
      info.first = false;
      this.errorCount = 0;
      this.lastError = '';
      info.tokenReset = false;

      if (data.offlineAt) {
        this.stop('配信が終了しました');
        return;
      }
      const apiMin = Number(data.pollingIntervalMillis) || 0;
      // 取り切れなかった（上限件数ちょうど返ってきた）場合は間を空けずに続きを取る
      wait = items.length >= 2000 ? Math.max(1000, apiMin) : this._nextWait(apiMin);
    } catch (e) {
      if (gen !== this.gen) return;
      if (e.reason === 'quotaExceeded' || e.reason === 'dailyLimitExceeded') {
        // 1 日の上限。リセット後に自動で再開する
        this.lastError = 'YouTube API の1日の上限に達しました。リセット後に自動で再開します';
        this._schedule(gen, this.quota.resetAt() - Date.now() + 60000);
        return;
      }
      if (e.status === 400 && info.pageToken && !info.tokenReset) {
        // 長く休止した後などでページトークンが無効になった場合は、トークンなしで取り直す（重複は seen で除外）
        info.pageToken = null;
        info.tokenReset = true;
        this._schedule(gen, 1000);
        return;
      }
      const fatal = e.status && e.status >= 400 && e.status < 500 && e.status !== 429 && !RETRYABLE_REASONS.has(e.reason);
      if (fatal) {
        this.stop(e.message);
        return;
      }
      // 通信エラーなどは間隔を延ばしながら再試行し続ける（長時間配信でも止めない）
      this.errorCount += 1;
      this.lastError = e.message;
      wait = Math.max(this._nextWait(0), Math.min(60000, 5000 * 2 ** Math.min(this.errorCount, 4)));
    }
    if (this.running && gen === this.gen) this._schedule(gen, wait);
  }
}

module.exports = { YouTubeLiveChat, extractVideoId, normalize, tierColors, TIER_COLORS };
