'use strict';

const { EventEmitter } = require('events');

const BASE = 'https://app.singular.live/apiv2/controlapps';

async function request(appToken, method, suffix, body) {
  if (!appToken) throw new Error('Singular の Control App Token が未設定です');
  const res = await fetch(`${BASE}/${encodeURIComponent(appToken)}/${suffix}`, {
    method,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Singular API エラー (${res.status}): ${text.slice(0, 200) || res.statusText}`);
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

// サブコンポジション名を model から集める（構造が多少違っても拾えるよう再帰的に探す）
function collectNames(node, out = new Set(), depth = 0) {
  if (!node || typeof node !== 'object' || depth > 12) return out;
  if (Array.isArray(node)) {
    for (const n of node) collectNames(n, out, depth + 1);
    return out;
  }
  if (typeof node.name === 'string' && (node.subCompositionId || node.id)) out.add(node.name);
  for (const v of Object.values(node)) collectNames(v, out, depth + 1);
  return out;
}

async function testConnection(appToken, subCompositionName) {
  const model = await request(appToken, 'GET', 'model');
  const names = [...collectNames(model)];
  return {
    subCompositions: names,
    found: names.length ? names.includes(subCompositionName) : null,
  };
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
  // 通常コメントは auto（テンプレート側で金額なし＝通常コメントの色になる）
  put(fields.color, msg.colors?.header || 'auto');
  return payload;
}

/**
 * 表示の出し方（Singular テンプレートの推奨手順に合わせる）
 * - 登場：内容（payload）を送ってから、別のリクエストで state In
 * - 表示中に次を出す：既定では Out せず内容だけ送り直す（テンプレート側の更新アニメ）。
 *   設定で「いったん Out してから出す」も選べる
 * - 退場：state Out
 *
 * CG 送出キュー。1 件ずつ In → 表示秒数待機 → Out → 間隔待機 → 次 の順に処理する。
 * - 自動モード：キューに入ったものを順に送出
 * - 手動モード：「今すぐ送出」「キューの先頭を送出」を押したときだけ送出
 * - displaySeconds が 0 のときは OUT を押すまで表示し続ける
 * - 送出に失敗した場合はキューの先頭に戻して自動送出を止める（誤設定でキューを消費しないため）
 */
class CgController extends EventEmitter {
  constructor(getSettings, { dryRun = false } = {}) {
    super();
    this.getSettings = getSettings;
    this.dryRun = dryRun;
    this.queue = [];
    this.current = null;
    this.busy = false;
    this.halted = false;
    this.pending = null;
    this.outTimer = null;
    this.nextTimer = null;
    this.outAt = 0;
    this.duration = 0;
  }

  state() {
    return {
      current: this.current,
      queue: this.queue,
      // 端末間の時計ずれに影響されないよう残り時間で渡す
      remainMs: this.outAt ? Math.max(0, this.outAt - Date.now()) : 0,
      duration: this.duration,
      halted: this.halted,
    };
  }

  _changed() {
    this.emit('state', this.state());
  }

  _auto() {
    return Boolean(this.getSettings().singular.autoSend) && !this.halted;
  }

  async _control(commands) {
    if (this.dryRun) {
      this.emit('log', `[デモ] Singular へ送信: ${JSON.stringify(commands)}`);
      return;
    }
    const s = this.getSettings().singular;
    await request(s.appToken, 'PATCH', 'control', commands);
  }

  has(id) {
    return this.current?.id === id || this.queue.some((m) => m.id === id);
  }

  enqueue(msg) {
    if (this.has(msg.id)) return;
    this.queue.push(msg);
    this._changed();
    this._next(false);
  }

  _swapInPlace() {
    return this.getSettings().singular.swapInPlace !== false;
  }

  // 表示中のものを下げずに、キューの先頭の内容へ入れ替える
  _swapToNext() {
    if (!this.queue.length) return;
    // 送信中なら、終わってから入れ替える
    if (this.busy) {
      this.pending = 'swap';
      return;
    }
    clearTimeout(this.outTimer);
    this.outTimer = null;
    this.outAt = 0;
    this._show(this.queue.shift(), { update: true });
  }

  // 表示中があれば入れ替えて（設定によっては Out してから）、このメッセージを出す
  sendNow(msg) {
    this.queue = this.queue.filter((m) => m.id !== msg.id);
    this.queue.unshift(msg);
    this.halted = false;
    this._changed();
    this.playNext();
  }

  // キューの先頭を出す（表示中なら入れ替え）
  playNext() {
    if (!this.queue.length) return;
    this.halted = false;
    if (!this.current) this._next(true);
    else if (this._swapInPlace()) this._swapToNext();
    else this.out({ advance: true });
  }

  // 表示時間が過ぎたとき：次が待っていれば入れ替え（設定による）、なければ下げる
  _onDisplayEnd() {
    if (this._swapInPlace() && this._auto() && this.queue.length) this._swapToNext();
    else this.out();
  }

  moveToTop(id) {
    const msg = this.queue.find((m) => m.id === id);
    if (!msg) return;
    this.queue = [msg, ...this.queue.filter((m) => m.id !== id)];
    this._changed();
  }

  remove(id) {
    this.queue = this.queue.filter((m) => m.id !== id);
    this._changed();
  }

  clearQueue() {
    this.queue = [];
    this._changed();
  }

  _next(force) {
    if (this.current || this.busy || !this.queue.length) return;
    if (!force && (this.nextTimer || !this._auto())) return;
    clearTimeout(this.nextTimer);
    this.nextTimer = null;
    this._show(this.queue.shift());
  }

  // update=true は表示中の入れ替え（内容だけ送る）。false は内容を送ってから In
  async _show(msg, { update = false } = {}) {
    const s = this.getSettings().singular;
    this.busy = true;
    this.current = msg;
    this._changed();
    try {
      if (!s.subCompositionName) throw new Error('Singular のサブコンポジション名が未設定です');
      const target = { subCompositionName: s.subCompositionName };
      await this._control([{ ...target, payload: buildPayload(msg, s.fields) }]);
      // payload と state を同じリクエストに入れた場合の反映順が未確認のため、In は別に送る
      if (!update) await this._control([{ ...target, state: 'In' }]);
    } catch (e) {
      this.busy = false;
      this.pending = null;
      this.current = null;
      this.queue.unshift(msg);
      this.halted = true;
      this._changed();
      this.emit('error', new Error(`送出できませんでした：${e.message}（自動送出を一時停止しました）`));
      return;
    }
    this.busy = false;
    this.emit('sent', msg);
    // 送信中に押された操作を実行
    const pending = this.pending;
    this.pending = null;
    if (pending === 'swap') {
      this._changed();
      this._swapToNext();
      return;
    }
    if (pending === 'out') {
      this._changed();
      this.out();
      return;
    }
    this.emit('log', `送出：${msg.name} ${msg.amount || ''}`.trim());
    const sec = Math.max(0, Number(s.displaySeconds) || 0);
    this.duration = sec * 1000;
    if (sec > 0) {
      this.outAt = Date.now() + this.duration;
      this.outTimer = setTimeout(() => this._onDisplayEnd(), this.duration);
    } else {
      this.outAt = 0;
    }
    this._changed();
  }

  async out({ advance = false } = {}) {
    clearTimeout(this.outTimer);
    this.outTimer = null;
    if (this.busy) {
      // 登場の送信中なら終わってから下げる（退場の送信中なら何もしない）
      if (this.current) this.pending = 'out';
      return;
    }
    const s = this.getSettings().singular;
    const had = this.current;
    this.current = null;
    this.outAt = 0;
    this._changed();
    if (had) this.emit('log', `OUT：${had.name}`);
    if (s.subCompositionName) {
      this.busy = true;
      try {
        await this._control([{ subCompositionName: s.subCompositionName, state: 'Out' }]);
      } catch (e) {
        this.emit('error', new Error(`OUT できませんでした：${e.message}`));
      } finally {
        this.busy = false;
      }
    }
    if (advance || this._auto()) {
      clearTimeout(this.nextTimer);
      this.nextTimer = setTimeout(() => {
        this.nextTimer = null;
        this._next(advance);
      }, Math.max(0, Number(s.gapSeconds) || 0) * 1000);
    }
  }

  // 設定変更（自動送出 ON など）を反映
  kick() {
    this._next(false);
  }
}

module.exports = { CgController, testConnection, buildPayload };
