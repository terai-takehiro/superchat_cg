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
  put(fields.color, msg.colors?.header || '');
  return payload;
}

/**
 * 表示の切り替え方は 2 通り。
 * - 表示フラグ（fields.show）が空：Singular 標準の state In / Out で登場・退場
 * - 表示フラグあり：そのフィールドに true / false を送って登場・退場（テンプレート側のスクリプトで制御）。
 *   続けて出すときは退場させず、表示フラグ true のまま内容だけ送って入れ替える
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

  _showField() {
    return this.getSettings().singular.fields.show || '';
  }

  // 表示中のものを下げずに、キューの先頭へ入れ替える（表示フラグ方式のとき）
  _swapToNext() {
    clearTimeout(this.outTimer);
    this.outTimer = null;
    if (this.busy) return;
    this.current = null;
    this.outAt = 0;
    this._next(true);
  }

  // 表示中があれば入れ替えて（標準方式は Out してから）、このメッセージを出す
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
    else if (this._showField()) this._swapToNext();
    else this.out({ advance: true });
  }

  // 表示時間が過ぎたとき：表示フラグ方式で次が待っていれば入れ替え、なければ下げる
  _onDisplayEnd() {
    if (this._showField() && this._auto() && this.queue.length) this._swapToNext();
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

  async _show(msg) {
    const s = this.getSettings().singular;
    this.busy = true;
    this.current = msg;
    this._changed();
    try {
      if (!s.subCompositionName) throw new Error('Singular のサブコンポジション名が未設定です');
      const payload = buildPayload(msg, s.fields);
      const show = this._showField();
      await this._control([
        show
          ? { subCompositionName: s.subCompositionName, payload: { ...payload, [show]: true } }
          : { subCompositionName: s.subCompositionName, state: 'In', payload },
      ]);
    } catch (e) {
      this.busy = false;
      this.current = null;
      this.queue.unshift(msg);
      this.halted = true;
      this._changed();
      this.emit('error', new Error(`送出できませんでした：${e.message}（自動送出を一時停止しました）`));
      return;
    }
    this.busy = false;
    this.emit('sent', msg);
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
    if (this.busy) return;
    const s = this.getSettings().singular;
    const had = this.current;
    this.current = null;
    this.outAt = 0;
    this._changed();
    if (had) this.emit('log', `OUT：${had.name}`);
    if (s.subCompositionName) {
      this.busy = true;
      try {
        const show = this._showField();
        await this._control([
          show
            ? { subCompositionName: s.subCompositionName, payload: { [show]: false } }
            : { subCompositionName: s.subCompositionName, state: 'Out' },
        ]);
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
