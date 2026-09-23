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
  setRadio('fetchMode', s.youtube.mode);
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
  $('dispSec').value = s.singular.displaySeconds;
  $('gapSec').value = s.singular.gapSeconds;

  $('portInput').value = s.port;
  setRadio('host', s.host);
  dirty = false;
}

function collect() {
  return {
    port: Number($('portInput').value),
    host: radio('host'),
    youtube: {
      apiKey: $('ytKey').value.trim(),
      video: $('ytVideo').value.trim(),
      mode: radio('fetchMode'),
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
      displaySeconds: Number($('dispSec').value),
      gapSeconds: Number($('gapSec').value),
    },
  };
}

const LABELS = { port: 'portInput', fetchMode: 'fetchMode', ytInterval: 'ytInterval', dispSec: 'dispSec', gapSec: 'gapSec' };

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
  if (!s.youtube.hasApiKey) w.push('YouTube の API Key');
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
