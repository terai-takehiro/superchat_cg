'use strict';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hms = (d) => new Date(d).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

const state = {
  messages: [],
  cg: { current: null, queue: [], remainMs: 0, duration: 0, halted: false },
  cgReceivedAt: 0,
  youtube: { running: false, title: '', lastError: '' },
  settings: null,
  selectedId: null,
  view: localStorageGet('viewMode') || null,
  demo: false,
  freshIds: new Set(),
};

function localStorageGet(k) {
  try { return localStorage.getItem(k); } catch { return null; }
}
function localStorageSet(k, v) {
  try { localStorage.setItem(k, v); } catch { /* 保存できなくても動作に支障なし */ }
}

// ---------- API ----------
async function api(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `エラー (${res.status})`);
  return data;
}

// 連打・二重タップ防止（送出系ボタンは押した直後 0.8 秒受け付けない）
let lockUntil = 0;
const locked = () => Date.now() < lockUntil;
async function guarded(fn) {
  if (locked()) return;
  lockUntil = Date.now() + 800;
  render();
  setTimeout(render, 820);
  try {
    await fn();
  } catch (e) {
    showAlert(e.message);
  }
}

// ---------- 表示ヘルパー ----------
const find = (id) => state.messages.find((m) => m.id === id) || state.cg.queue.find((m) => m.id === id) || (state.cg.current?.id === id ? state.cg.current : null);
const inQueue = (id) => state.cg.queue.some((q) => q.id === id);
// 設定で「スパチャのみ」取得なら通常コメントは届かないので、表示切替も出さない
const fetchAll = () => state.settings?.youtube.mode === 'all';
const viewMode = () => (fetchAll() ? state.view || 'all' : 'superchat');
const visible = (m) => (viewMode() === 'all' || m.type !== 'text') && !($('hideSent').checked && m.sent);
const tierStyle = (m) => `--tier:${m.colors?.header || 'var(--gray-200)'};--tier-fg:${m.colors?.text || '#fff'}`;
const amountBadge = (m) => (m.amount ? `<span class="amount" style="${tierStyle(m)}"><span class="visually-hidden">スーパーチャット </span>${esc(m.amount)}</span>` : '');
// コメント本文を HTML に。チャンネル独自の絵文字（:_name:）は画像で表示する
function commentHtml(m) {
  const map = m.emojis || {};
  return esc(m.comment || '').replace(/:_[^:\s]+:/g, (code) => {
    const url = map[code];
    return url ? `<img class="yt-emoji" src="${esc(url)}" alt="${code}" title="${code}" referrerpolicy="no-referrer">` : code;
  });
}

function avatar(m) {
  if (m.icon) return `<span class="avatar" aria-hidden="true"><img src="${esc(m.icon)}" alt="" loading="lazy" referrerpolicy="no-referrer"></span>`;
  const hue = [...(m.name || '?')].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
  return `<span class="avatar" aria-hidden="true" style="background:hsl(${hue} 40% 38%)">${esc([...(m.name || '?')][0])}</span>`;
}

function showAlert(text, kind = 'error') {
  const el = document.createElement('div');
  el.className = `notice ${kind}`;
  el.innerHTML = `<span aria-hidden="true">!</span><div class="grow">${esc(text)}</div><button class="btn btn-tertiary" style="min-height:48px">閉じる</button>`;
  el.querySelector('button').onclick = () => el.remove();
  $('alerts').prepend(el);
  while ($('alerts').children.length > 3) $('alerts').lastElementChild.remove();
}

function addLog(entry) {
  const li = document.createElement('li');
  if (entry.level === 'error') li.className = 'err';
  li.innerHTML = `<span class="mono">${hms(entry.time)}</span> ${esc(entry.text)}`;
  $('log').prepend(li);
  while ($('log').children.length > 100) $('log').lastElementChild.remove();
}

// ---------- 描画 ----------
function renderFeed() {
  if ($('pause').checked) return;
  const list = state.messages.filter(visible);
  $('count').textContent = `${list.length}件`;
  $('feed').innerHTML = list.map((m) => {
    const sel = state.selectedId === m.id;
    const cls = ['msg', m.type !== 'text' ? 'sc' : '', m.sent ? 'is-sent' : '', state.freshIds.has(m.id) ? 'new' : ''].join(' ');
    return `<li><button class="${cls}" data-pick="${esc(m.id)}" aria-pressed="${sel}">
      ${avatar(m)}
      <span>
        <span class="meta">
          ${sel ? '<span class="selected-mark">選択中</span>' : ''}
          <span class="name">${esc(m.name)}</span>
          ${amountBadge(m)}
          ${m.type === 'supersticker' ? '<span class="label">ステッカー</span>' : ''}
          ${m.isOwner ? '<span class="label">配信者</span>' : ''}
          ${m.isModerator ? '<span class="label">モデレーター</span>' : ''}
          ${m.isMember ? '<span class="label member">メンバー</span>' : ''}
          ${m.sent ? '<span class="label done">送出済み</span>' : ''}
          ${inQueue(m.id) ? '<span class="label queued">キュー待ち</span>' : ''}
          <time class="time">${hms(m.publishedAt)}</time>
        </span>
        <span class="comment ${m.comment ? '' : 'none'}" style="display:block">${m.comment ? commentHtml(m) : '（コメントなし）'}</span>
      </span>
    </button></li>`;
  }).join('') || `<li class="empty">${state.youtube.running ? '表示するコメントはまだありません' : 'コメントの取得を開始してください'}</li>`;
  state.freshIds.clear();
}

function renderPicked() {
  const m = state.selectedId ? find(state.selectedId) : null;
  if (state.selectedId && !m) state.selectedId = null;
  const box = $('picked');
  box.classList.toggle('has', !!m);
  box.innerHTML = m
    ? `<span class="meta"><b>${esc(m.name)}</b>${amountBadge(m)}</span><span class="c">${m.comment ? commentHtml(m) : '（コメントなし）'}</span>`
    : '<span class="none">左の一覧からコメントを選んでください</span>';
  $('sendBtn').disabled = !m || locked();
  $('queueBtn').disabled = !m || inQueue(m.id);
  $('unpick').hidden = !m;
  $('sendSub').textContent = m && state.cg.current ? '（表示中と入れ替え）' : '';
}

function renderQueue() {
  const q = state.cg.queue;
  $('qcount').textContent = `${q.length}件`;
  $('clearQ').disabled = !q.length;
  $('nextBtn').disabled = !q.length || locked();
  $('queue').innerHTML = q.map((m, i) => `
    <li class="qitem">
      <span class="n">${i + 1}</span>
      <span class="t"><b>${esc(m.name)}</b> ${amountBadge(m)}　${commentHtml(m)}</span>
      <button class="icon-btn" data-top="${esc(m.id)}" ${i === 0 ? 'disabled' : ''} aria-label="${esc(m.name)}を先頭へ移動">↑</button>
      <button class="icon-btn" data-del="${esc(m.id)}" aria-label="${esc(m.name)}をキューから削除">✕</button>
    </li>`).join('') || '<li class="empty">キューは空です</li>';
}

function renderOnair() {
  const m = state.cg.current;
  $('onair').classList.toggle('live', !!m);
  $('lamp').textContent = m ? 'ON AIR' : '待機中';
  $('onairName').textContent = m ? `${m.name}　${m.amount || ''}` : 'なし';
  // CG が出ていないときも、念のため OUT を送れるようにしておく
  $('outBtn').disabled = locked();
  $('lt').classList.toggle('in', !!m);
  if (m) {
    $('lt').style.setProperty('--tier', m.colors?.header || 'var(--blue-900)');
    $('lt').style.setProperty('--tier-fg', m.colors?.text || '#fff');
    $('ltName').textContent = m.name;
    $('ltAmount').textContent = m.amount || '';
    // CG に送る内容に合わせる（チャンネル独自の絵文字は設定により取り除く）
    const keep = state.settings?.singular.customEmoji === 'keep';
    $('ltComment').textContent = keep ? m.comment || '' : (m.comment || '').replace(/:_[^:\s]+:/g, '').replace(/[ \u3000]{2,}/g, ' ').trim();
  }
}

function renderStatus() {
  const yt = state.youtube;
  const on = yt.running;
  const busy = on || yt.reconnecting; // 取得中または自動再接続中は「停止」ボタンを出す
  $('liveBar').classList.toggle('on', on);
  $('liveState').textContent = on ? '取得中' : yt.reconnecting ? '再接続中' : '停止中';
  $('liveTitle').textContent = yt.title || (state.settings?.youtube.video ? state.settings.youtube.video : '未設定（設定画面で配信URLを入力してください）');
  $('liveQuota').innerHTML = quotaText(yt);
  $('liveBtn').textContent = busy ? '取得を停止する' : '取得を開始する';
  $('liveBtn').className = `btn ${busy ? 'btn-secondary' : 'btn-primary'}`;
  const st = $('ytStatus');
  st.className = `status ${on ? 'ok' : yt.lastError ? 'err' : 'off'}`;
  st.querySelector('.icon').textContent = on ? '✓' : yt.lastError ? '!' : '–';
  $('ytLabel').textContent = on ? (yt.lastError ? '再試行中' : '取得中') : yt.reconnecting ? '再接続中' : yt.lastError ? 'エラー' : '停止中';
  $('sendModeLabel').textContent = state.settings ? (state.settings.singular.autoSend ? (state.cg.halted ? '自動（一時停止中）' : '自動') : '手動') : '—';
  $('demoBadge').hidden = !state.demo;
  $('modeSeg').hidden = !fetchAll();
  document.querySelectorAll('input[name=mode]').forEach((r) => { r.checked = r.value === viewMode(); });
}

const hm = (t) => new Date(t).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
function quotaText(yt) {
  if (!yt.dailyQuota) return yt.running && yt.intervalMs ? `取得間隔 <b>約 ${Math.round(yt.intervalMs / 1000)} 秒</b>` : '';
  const lines = [];
  if (yt.running && yt.pausedUntil) {
    lines.push(`<span class="paused">API の上限に達したため ${hm(yt.pausedUntil)} まで休止中（自動で再開）</span>`);
  } else if (yt.running && yt.intervalMs) {
    lines.push(`取得間隔 <b>約 ${Math.round(yt.intervalMs / 1000)} 秒</b>`);
  }
  lines.push(`API 使用量 <b>${yt.quotaUsed.toLocaleString()}</b> / ${yt.dailyQuota.toLocaleString()}（${hm(yt.resetAt)} リセット）`);
  return lines.join('<br>');
}

function render() {
  renderFeed();
  renderPicked();
  renderQueue();
  renderOnair();
  renderStatus();
}

(function tick() {
  const { current, remainMs, duration } = state.cg;
  if (current && remainMs && duration) {
    const left = Math.max(0, remainMs - (Date.now() - state.cgReceivedAt));
    $('bar').style.width = `${(left / duration) * 100}%`;
    $('remainText').textContent = `残り ${Math.ceil(left / 1000)} 秒`;
  } else {
    $('bar').style.width = current ? '100%' : '0';
    $('remainText').textContent = current ? '「OUT」を押すまで表示' : '残り —';
  }
  requestAnimationFrame(tick);
})();

// ---------- サーバーからのイベント ----------
function connect() {
  const es = new EventSource('/api/events');
  es.addEventListener('snapshot', (e) => {
    const d = JSON.parse(e.data);
    state.messages = d.messages;
    state.cg = d.cg;
    state.cgReceivedAt = Date.now();
    state.youtube = d.youtube;
    state.settings = d.settings;
    state.demo = d.demo;
    $('log').innerHTML = '';
    d.logs.slice().reverse().forEach(addLog);
    $('connLost').hidden = true;
    render();
  });
  es.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    state.messages.unshift(m);
    if (state.messages.length > 500) state.messages.length = 500;
    state.freshIds.add(m.id);
    renderFeed();
  });
  es.addEventListener('sent', (e) => {
    const { id } = JSON.parse(e.data);
    const m = state.messages.find((x) => x.id === id);
    if (m) m.sent = true;
    renderFeed();
  });
  es.addEventListener('cg', (e) => {
    state.cg = JSON.parse(e.data);
    state.cgReceivedAt = Date.now();
    render();
  });
  es.addEventListener('youtube', (e) => {
    state.youtube = JSON.parse(e.data);
    renderStatus();
    renderFeed();
  });
  es.addEventListener('settings', (e) => {
    state.settings = JSON.parse(e.data);
    render();
  });
  es.addEventListener('log', (e) => {
    const entry = JSON.parse(e.data);
    addLog(entry);
    if (entry.level === 'error') showAlert(entry.text);
  });
  es.onerror = () => { $('connLost').hidden = false; };
  es.onopen = () => { $('connLost').hidden = true; };
}

// ---------- 操作 ----------
document.addEventListener('click', (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  if (t.dataset.pick) {
    state.selectedId = state.selectedId === t.dataset.pick ? null : t.dataset.pick;
    renderFeed();
    renderPicked();
  }
  if (t.dataset.del) api('/api/cg/remove', { id: t.dataset.del }).catch((err) => showAlert(err.message));
  if (t.dataset.top) api('/api/cg/top', { id: t.dataset.top }).catch((err) => showAlert(err.message));
});

$('sendBtn').onclick = () => guarded(async () => {
  const id = state.selectedId;
  if (!id) return;
  state.selectedId = null;
  await api('/api/cg/send', { id });
});
$('queueBtn').onclick = async () => {
  const id = state.selectedId;
  if (!id) return;
  state.selectedId = null;
  try { await api('/api/cg/queue', { id }); } catch (e) { showAlert(e.message); }
  render();
};
$('unpick').onclick = () => { state.selectedId = null; render(); };
$('outBtn').onclick = () => guarded(() => api('/api/cg/out'));
$('nextBtn').onclick = () => guarded(() => api('/api/cg/next'));
$('clearQ').onclick = () => {
  if (confirm(`待機キュー ${state.cg.queue.length}件をすべて削除しますか？`)) api('/api/cg/clear').catch((e) => showAlert(e.message));
};
$('liveBtn').onclick = async () => {
  const running = state.youtube.running || state.youtube.reconnecting;
  if (running && !confirm('コメントの取得を停止しますか？\n停止中に届いたスパチャは取り込まれません。')) return;
  $('liveBtn').disabled = true;
  try {
    state.youtube = await api(running ? '/api/youtube/stop' : '/api/youtube/start');
  } catch (e) {
    showAlert(e.message);
  } finally {
    $('liveBtn').disabled = false;
    renderStatus();
  }
};
document.querySelectorAll('input[name=mode]').forEach((r) => {
  r.onchange = () => { state.view = r.value; localStorageSet('viewMode', r.value); renderFeed(); };
});
$('hideSent').onchange = renderFeed;
$('pause').onchange = renderFeed;

// キーボードショートカット（入力中は無効）
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea') || e.repeat) return;
  if (e.key === 'Escape') { e.preventDefault(); $('outBtn').click(); }
  if (e.key === 'n' || e.key === 'N') $('nextBtn').click();
});

connect();
