'use strict';

const { EventEmitter } = require('events');

const BASE = 'https://app.singular.live/apiv2/controlapps';

async function request(appToken, method, suffix, body) {
  if (!appToken) throw new Error('Singular の App Token が未設定です');
  const res = await fetch(`${BASE}/${encodeURIComponent(appToken)}/${suffix}`, {
    method,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Singular API エラー (${res.status}): ${text.slice(0, 300) || res.statusText}`);
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

function control(appToken, commands) {
  return request(appToken, 'PUT', 'control', commands);
}

async function testConnection(appToken) {
  const model = await request(appToken, 'GET', 'model');
  const names = [];
  const walk = (nodes) => {
    for (const n of Array.isArray(nodes) ? nodes : [nodes]) {
      if (!n || typeof n !== 'object') continue;
      if (n.name) names.push(n.name);
      if (n.subcompositions) walk(n.subcompositions);
    }
  };
  walk(model);
  return { subCompositions: names };
}

function buildPayload(msg, fields) {
  const payload = {};
  const put = (fieldId, value) => {
    if (fieldId) payload[fieldId] = value;
  };
  put(fields.name, msg.name || '');
  put(fields.amount, msg.amount || '');
  put(fields.comment, msg.comment || '');
  put(fields.icon, msg.icon || '');
  put(fields.type, msg.type || '');
  return payload;
}

/**
 * CG 送出キュー。1 件ずつ In → 表示秒数待機 → Out → 間隔待機 → 次 の順に処理する。
 * displaySeconds が 0 の場合は手動で Out するまで表示し続ける。
 */
class CgController extends EventEmitter {
  constructor(getSettings) {
    super();
    this.getSettings = getSettings;
    this.queue = [];
    this.current = null;
    this.busy = false;
    this.outTimer = null;
    this.nextTimer = null;
    this.outAt = 0;
  }

  state() {
    return {
      current: this.current,
      queue: this.queue,
      outAt: this.outAt,
    };
  }

  _changed() {
    this.emit('state', this.state());
  }

  enqueue(msg) {
    if (this.current?.id === msg.id || this.queue.some((m) => m.id === msg.id)) return;
    this.queue.push(msg);
    this._changed();
    this._next();
  }

  // キューの先頭に割り込ませて、表示中のものがあれば Out してから出す
  async sendNow(msg) {
    this.queue = this.queue.filter((m) => m.id !== msg.id);
    this.queue.unshift(msg);
    this._changed();
    if (this.current) await this.out();
    else this._next();
  }

  remove(id) {
    this.queue = this.queue.filter((m) => m.id !== id);
    this._changed();
  }

  clearQueue() {
    this.queue = [];
    this._changed();
  }

  _next() {
    if (this.current || this.busy || this.nextTimer || !this.queue.length) return;
    this._show(this.queue.shift());
  }

  async _show(msg) {
    const s = this.getSettings().singular;
    this.busy = true;
    this.current = msg;
    this._changed();
    try {
      if (!s.subCompositionName) throw new Error('Singular のサブコンポジション名が未設定です');
      await control(s.appToken, [
        { subCompositionName: s.subCompositionName, state: 'In', payload: buildPayload(msg, s.fields) },
      ]);
      this.emit('log', `CG 送出: ${msg.name} ${msg.amount || ''}`.trim());
    } catch (e) {
      this.emit('error', e);
      this.current = null;
      this.busy = false;
      this._changed();
      this._scheduleNext(3000);
      return;
    }
    this.busy = false;
    const sec = Number(s.displaySeconds) || 0;
    if (sec > 0) {
      this.outAt = Date.now() + sec * 1000;
      this.outTimer = setTimeout(() => this.out(), sec * 1000);
    } else {
      this.outAt = 0;
    }
    this._changed();
  }

  async out() {
    clearTimeout(this.outTimer);
    this.outTimer = null;
    this.outAt = 0;
    if (this.busy) return;
    const s = this.getSettings().singular;
    const had = this.current;
    this.current = null;
    this._changed();
    if (had || s.subCompositionName) {
      try {
        this.busy = true;
        if (s.subCompositionName) {
          await control(s.appToken, [{ subCompositionName: s.subCompositionName, state: 'Out' }]);
        }
      } catch (e) {
        this.emit('error', e);
      } finally {
        this.busy = false;
      }
    }
    this._scheduleNext((Number(s.gapSeconds) || 0) * 1000);
  }

  _scheduleNext(ms) {
    clearTimeout(this.nextTimer);
    this.nextTimer = setTimeout(() => {
      this.nextTimer = null;
      this._next();
    }, ms);
  }
}

module.exports = { CgController, control, testConnection, buildPayload };
