'use strict';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const radio = (name) => document.querySelector(`input[name=${name}]:checked`)?.value;
const setRadio = (name, value) => {
  const r = document.querySelector(`input[name=${name}][value="${value}"]`);
  if (r) r.checked = true;
};

let server = { port: 0, host: '' };
let dirty = false;

function fill(s) {
  $('ytKey').value = '';
  $('ytKey').placeholder = s.youtube.hasApiKey ? '設定済み（変更する場合のみ入力）' : '';
  $('ytKey-state').textContent = s.youtube.hasApiKey ? '✓ 設定済み' : '';
  $('ytVideo').value = s.youtube.video;
  $('catSuperchat').checked = s.youtube.categories.superchat;
  $('catMember').checked = s.youtube.categories.member;
  $('catNormal').checked = s.youtube.categories.normal;
  setRadio('source', s.youtube.source);
  setRadio('pacing', s.youtube.pacing);
  $('ytQuota').value = s.youtube.dailyQuota;
  $('ytInterval').value = s.youtube.minIntervalMs / 1000;
  $('ytBacklog').value = s.youtube.skipBacklog ? 'skip' : 'load';

  $('sgToken').value = '';
  $('sgToken').placeholder = s.singular.hasAppToken ? '設定済み（変更する場合のみ入力）' : '';
  $('sgToken-state').textContent = s.singular.hasAppToken ? '✓ 設定済み' : '';
  $('sgSub').value = s.singular.subCompositionName;
  $('fName').value = s.singular.fields.name;
  $('fAmount').value = s.singular.fields.amount;
  $('fComment').value = s.singular.fields.comment;
  $('fIcon').value = s.singular.fields.icon;
  $('fColor').value = s.singular.fields.color;

  setRadio('sendMode', s.singular.autoSend ? 'auto' : 'manual');
  setRadio('customEmoji', s.singular.customEmoji === 'keep' ? 'keep' : 'remove');
  setRadio('swapMode', s.singular.swapInPlace === false ? 'outin' : 'update');
  $('dispSec').value = s.singular.displaySeconds;
  $('gapSec').value = s.singular.gapSeconds;

  $('portInput').value = s.port;
  setRadio('host', s.host);
  dirty = false;
  renderSource();
  renderEstimate();
}

// API 専用の項目は「YouTube Data API」を選んだときだけ表示
function renderSource() {
  $('apiFields').hidden = radio('source') !== 'api';
}
document.querySelectorAll('input[name=source]').forEach((r) => r.addEventListener('change', renderSource));

// 取得間隔の目安を表示
function renderEstimate() {
  const quota = Number($('ytQuota').value) || 0;
  const calls = Math.floor(Math.max(0, quota - 50) / 5);
  const auto = radio('pacing') !== 'fixed';
  $('ytInterval').disabled = auto;
  let text;
  if (!calls) {
    text = '1日の上限を入力してください';
  } else if (auto) {
    const sec = Math.ceil(86400 / calls);
    text = `目安：約 ${sec} 秒ごとに取得（1日 ${calls.toLocaleString()} 回）。上限を増やすと間隔が短くなります。`;
    if (sec > 30) text += ' 長時間配信で反映を速くしたい場合は、Google に上限の引き上げを申請してください。';
  } else {
    const iv = Math.max(1, Number($('ytInterval').value) || 5);
    const hours = (calls * iv) / 3600;
    text = hours >= 24
      ? `目安：${iv} 秒ごとなら1日中取得できます。`
      : `目安：${iv} 秒ごとだと約 ${hours.toFixed(1)} 時間で上限に達し、リセットまで取得が止まります。`;
  }
  $('paceEstimate').innerHTML = `<span aria-hidden="true">ℹ</span><div>${esc(text)}</div>`;
}
['ytQuota', 'ytInterval'].forEach((id) => $(id).addEventListener('input', renderEstimate));
document.querySelectorAll('input[name=pacing]').forEach((r) => r.addEventListener('change', renderEstimate));

function collect() {
  return {
    port: Number($('portInput').value),
    host: radio('host'),
    youtube: {
      apiKey: $('ytKey').value.trim(),
      video: $('ytVideo').value.trim(),
      categories: { superchat: $('catSuperchat').checked, member: $('catMember').checked, normal: $('catNormal').checked },
      source: radio('source'),
      pacing: radio('pacing'),
      dailyQuota: Number($('ytQuota').value),
      minIntervalMs: Math.round(Number($('ytInterval').value) * 1000),
      skipBacklog: $('ytBacklog').value === 'skip',
    },
    singular: {
      appToken: $('sgToken').value.trim(),
      subCompositionName: $('sgSub').value.trim(),
      fields: {
        name: $('fName').value.trim(),
        amount: $('fAmount').value.trim(),
        comment: $('fComment').value.trim(),
        icon: $('fIcon').value.trim(),
        color: $('fColor').value.trim(),
      },
      autoSend: radio('sendMode') === 'auto',
      swapInPlace: radio('swapMode') !== 'outin',
      customEmoji: radio('customEmoji') === 'keep' ? 'keep' : 'remove',
      displaySeconds: Number($('dispSec').value),
      gapSeconds: Number($('gapSec').value),
    },
  };
}

const LABELS = { port: 'portInput', catSuperchat: 'catSuperchat', ytInterval: 'ytInterval', ytQuota: 'ytQuota', pacing: 'pacing', source: 'source', dispSec: 'dispSec', gapSec: 'gapSec' };

function showErrors(errors) {
  document.querySelectorAll('[aria-invalid]').forEach((el) => el.removeAttribute('aria-invalid'));
  $('port-e').hidden = true;
  $('errorSummary').hidden = !errors.length;
  $('errorList').innerHTML = errors.map((e) => `<li><a href="#${LABELS[e.field] || e.field}" style="color:inherit">${esc(e.message)}</a></li>`).join('');
  for (const e of errors) {
    const el = $(LABELS[e.field] || e.field);
    if (el) el.setAttribute('aria-invalid', 'true');
    if (e.field === 'port') {
      $('port-e').hidden = false;
      $('port-e').textContent = e.message;
    }
  }
  if (errors.length) $('errorSummary').focus();
}

// 必須項目の未入力は「警告」として知らせる（途中まで入力して保存することもできる）
function missingWarnings(s) {
  const w = [];
  if (s.youtube.source === 'api' && !s.youtube.hasApiKey) w.push('YouTube の API Key');
  if (!s.youtube.video) w.push('配信のURL または 動画ID');
  if (!s.singular.hasAppToken) w.push('Control App Token');
  if (!s.singular.subCompositionName) w.push('サブコンポジション名');
  return w;
}

async function save() {
  $('saveMsg').textContent = '';
  const res = await fetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(collect()),
  });
  const data = await res.json().catch(() => ({}));
  if (data.errors) {
    showErrors(data.errors);
    $('saveMsg').className = 'msg-inline error-text';
    $('saveMsg').textContent = '保存できませんでした';
    return false;
  }
  if (!res.ok) throw new Error(data.error || `保存に失敗しました (${res.status})`);
  showErrors([]);
  fill({ ...data.settings });
  const missing = missingWarnings(data.settings);
  $('saveMsg').className = 'msg-inline ok-text';
  $('saveMsg').textContent = `✓ 保存しました${data.restartRequired ? '（ポート番号・操作できる端末はアプリの再起動後に反映）' : ''}${missing.length ? `　未入力：${missing.join('、')}` : ''}`;
  return true;
}

async function withSave(btn, path) {
  const out = $('testResult');
  btn.disabled = true;
  out.className = 'support';
  out.textContent = '確認しています…';
  try {
    if (!(await save())) {
      out.textContent = '';
      return;
    }
    const res = await fetch(path, { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    const ok = res.ok && data.ok !== false;
    out.className = ok ? 'ok-text' : 'error-text';
    out.textContent = `${ok ? '✓ ' : ''}${data.message || data.error || '失敗しました'}`;
  } catch (e) {
    out.className = 'error-text';
    out.textContent = e.message;
  } finally {
    btn.disabled = false;
  }
}

$('settingsForm').onsubmit = async (e) => {
  e.preventDefault();
  $('saveBtn').disabled = true;
  try {
    await save();
  } catch (err) {
    $('saveMsg').className = 'msg-inline error-text';
    $('saveMsg').textContent = err.message;
  } finally {
    $('saveBtn').disabled = false;
  }
};
$('testConn').onclick = (e) => withSave(e.currentTarget, '/api/singular/test');
$('testSend').onclick = (e) => withSave(e.currentTarget, '/api/singular/test-send');
$('settingsForm').addEventListener('input', () => { dirty = true; });
window.addEventListener('beforeunload', (e) => {
  if (dirty) e.preventDefault();
});

(async () => {
  const res = await fetch('/api/settings');
  const data = await res.json();
  server = { port: data.port, host: data.host };
  $('addr').textContent = `${data.host === '0.0.0.0' ? '（全体公開）' : 'localhost'}:${data.port}`;
  $('demoBadge').hidden = !data.demo;
  fill(data.settings);
})();
