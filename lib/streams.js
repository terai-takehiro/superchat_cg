'use strict';

// 複数の配信からコメントを同時に取得するためのまとめ役。
// 配信（URL）ごとに取得の仕組み（直接取得 / Data API / デモ）を 1 つずつ持ち、
// コメントと状態をまとめて外に出す。
const { EventEmitter } = require('events');

class StreamManager extends EventEmitter {
  // factory(): 取得の仕組みを 1 つ作る関数
  constructor(factory) {
    super();
    this.factory = factory;
    this.list = []; // { index, video, chat }
  }

  _info(entry) {
    return { index: entry.index, videoId: entry.chat.status().videoId, title: entry.chat.status().title || entry.video };
  }

  // 設定の URL 一覧から取得の仕組みを作り直す（取得中のものはすべて止める）
  rebuild(videos) {
    this.stopAll();
    for (const e of this.list) e.chat.removeAllListeners();
    this.list = videos.map((video, i) => {
      const entry = { index: i + 1, video, chat: this.factory() };
      entry.chat.on('message', (m) => this.emit('message', { ...m, stream: this._info(entry) }));
      entry.chat.on('status', () => this.emit('status', this.status()));
      return entry;
    });
  }

  _startOptions(opts, reconnect) {
    return {
      ...opts,
      // Data API の 1 日の上限を配信の数で分け合う
      share: Math.max(1, this.list.length),
      // 再接続時は、切れていた間のコメントを取りこぼさないよう直前の分も取り込む（取り込み済みは除外される）
      skipBacklog: reconnect ? false : opts.skipBacklog,
    };
  }

  // 1 つの配信の取得を始める。成功なら null、失敗ならエラーを返す
  async startOne(entry, opts, { reconnect = false } = {}) {
    try {
      await entry.chat.start({ ...this._startOptions(opts, reconnect), video: entry.video });
      entry.started = true;
      return null;
    } catch (e) {
      return e;
    }
  }

  // すべての配信の取得を始める。1 つでも始められれば成功。結果を配信ごとに返す
  async startAll(opts) {
    const results = await Promise.all(this.list.map((e) => this.startOne(e, opts)));
    return this.list.map((e, i) => ({ ...this._info(e), error: results[i] }));
  }

  stopAll() {
    for (const e of this.list) e.chat.stop();
  }

  // 止まっている配信（取得を続けたいのに止まったもの）
  stopped() {
    return this.list.filter((e) => !e.chat.status().running);
  }

  updateOptions(opts) {
    for (const e of this.list) e.chat.updateOptions({ ...opts, share: Math.max(1, this.list.length) });
  }

  status() {
    const streams = this.list.map((e) => {
      const s = e.chat.status();
      return { ...s, index: e.index, video: e.video, title: s.title || e.video };
    });
    const first = streams[0] || {};
    return {
      ...first,
      running: streams.some((s) => s.running),
      allRunning: streams.length > 0 && streams.every((s) => s.running),
      lastError: streams.find((s) => s.lastError)?.lastError || '',
      title: streams.map((s) => s.title).join(' / '),
      streams,
    };
  }
}

module.exports = { StreamManager };
