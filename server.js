'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const config = require('./lib/config');
const { IS_EXE, dataPath, readPublic } = require('./lib/paths');
const { YouTubeLiveChat, extractVideoId } = require('./lib/youtube');
const { QuotaTracker } = require('./lib/quota');
const { YouTubeWebChat } = require('./lib/youtube-web');
const { StreamManager } = require('./lib/streams');
const { DemoChat } = require('./lib/demo');
const { CgController, testConnection, buildPayload } = require('./lib/singular');

// ---------- 起動オプション ----------
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' || a === '-p') out.port = argv[++i];
    else if (a.startsWith('--port=')) out.port = a.slice(7);
    else if (a === '--host') out.host = argv[++i];
    else if (a.startsWith('--host=')) out.host = a.slice(7);
    else if (a === '--demo') out.demo = true;
    else if (a === '--no-open') out.noOpen = true;
    else if (a === '--open') out.open = true;
    else if (a === '--no-tray') out.noTray = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(`使い方: node server.js [--port 3000] [--host 127.0.0.1] [--demo]
  --port, -p  待ち受けポート番号（未指定時は設定画面の値、既定 3000）
  --host      待ち受けアドレス（0.0.0.0 で同じネットワークの他端末からも操作可）
  --demo      YouTube / Singular に接続せず、ダミーデータで動作確認する
  --open / --no-open  起動時にブラウザで操作画面を開く／開かない（exe 版は既定で開く）`);
  process.exit(0);
}

// Windows の exe はコマンドプロンプトを出さずに動く（ビルド時に GUI アプリとして作成）。
// その場合、画面に出していたログは exe の隣の superchat-cg.log に書き出し、操作はタスクトレイから行う
const GUI = IS_EXE && process.platform === 'win32';
const LOG_PATH = dataPath('superchat-cg.log');
if (GUI) {
  try {
    if (fs.statSync(LOG_PATH).size > 5e6) fs.renameSync(LOG_PATH, `${LOG_PATH}.old`);
  } catch {
    // ログファイルがまだない
  }
  const out = fs.createWriteStream(LOG_PATH, { flags: 'a' });
  const write = (...a) => out.write(`${new Date().toLocaleString('ja-JP')} ${require('util').format(...a)}\n`);
  console.log = write;
  console.error = write;
  console.warn = write;
}
const { startTray, showMessage } = require('./lib/tray');
const APP_VERSION = require('./package.json').version;

let settings = config.load();
let PORT = Number(args.port || process.env.PORT || settings.port) || 3000;
const HOST = args.host || process.env.HOST || settings.host || '127.0.0.1';
const DEMO = Boolean(args.demo);

// ---------- 状態 ----------
const MAX_HISTORY = 500;
let history = []; // 新しい順
const logs = [];

// 取得方法：web = YouTube から直接（上限なし） / api = YouTube Data API（1日の上限あり）
// 配信（URL）ごとに 1 つずつ作り、StreamManager でまとめて扱う
const quota = new QuotaTracker();
const createChat = () => {
  if (DEMO) return new DemoChat();
  return settings.youtube.source === 'api' ? new YouTubeLiveChat(quota) : new YouTubeWebChat();
};
const streams = new StreamManager(createChat);
streams.rebuild(settings.youtube.videos);

// 取得を「続けたい」状態を state.json に保存し、アプリ再起動や配信の一時中断から自動で復帰する
const STATE_PATH = dataPath('state.json');
let wantRunning = false;
try {
  wantRunning = Boolean(JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')).wantRunning);
} catch {
  // 初回起動
}
function setWantRunning(v) {
  wantRunning = v;
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify({ wantRunning: v }));
  } catch {
    // 保存できなくても動作は続ける
  }
}
const ytStatus = () => {
  const s = streams.status();
  return { ...s, reconnecting: wantRunning && !s.allRunning };
};
const cg = new CgController(() => settings, { dryRun: DEMO });

const clients = new Set();
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(payload);
}

function log(text, level = 'info') {
  const entry = { time: new Date().toISOString(), text, level };
  logs.unshift(entry);
  logs.length = Math.min(logs.length, 200);
  broadcast('log', entry);
  (level === 'error' ? console.error : console.log)(`[${level}] ${text}`);
}

function findMessage(id) {
  return history.find((m) => m.id === id) || cg.queue.find((m) => m.id === id) || null;
}

function onChatMessage(msg) {
  if (!settings.youtube.categories[config.categoryOf(msg)]) return;
  if (history.some((m) => m.id === msg.id)) return;
  msg.sent = false;
  history.unshift(msg);
  if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
  broadcast('message', msg);
  if (msg.type !== 'text' && settings.singular.autoSend) cg.enqueue(msg);
}
// 配信ごとにエラー文言が変わったときだけログに残す
const lastYtErrors = new Map();
function onChatStatus() {
  const s = ytStatus();
  broadcast('youtube', s);
  const multi = s.streams.length > 1;
  for (const st of s.streams) {
    const prev = lastYtErrors.get(st.index) || '';
    if (st.lastError && st.lastError !== prev) {
      const who = multi ? `配信${st.index}（${st.title}）` : 'YouTube';
      log(st.running ? `${who}：${st.lastError}` : `${who} の取得が止まりました：${st.lastError}`, 'error');
    }
    lastYtErrors.set(st.index, st.lastError);
  }
}
streams.on('message', onChatMessage);
streams.on('status', onChatStatus);

cg.on('state', (s) => broadcast('cg', s));
cg.on('log', (t) => log(t));
cg.on('error', (e) => log(e.message, 'error'));
cg.on('sent', (msg) => {
  const m = history.find((x) => x.id === msg.id);
  if (m) m.sent = true;
  msg.sent = true;
  broadcast('sent', { id: msg.id });
});

// ---------- 設定（キー類は画面に返さない） ----------
function publicSettings() {
  const s = JSON.parse(JSON.stringify(settings));
  s.youtube.hasApiKey = Boolean(s.youtube.apiKey);
  s.singular.hasAppToken = Boolean(s.singular.appToken);
  s.youtube.apiKey = '';
  s.singular.appToken = '';
  return s;
}

function validate(s) {
  const errors = [];
  if (!Number.isInteger(s.port) || s.port < 1024 || s.port > 65535) errors.push({ field: 'port', message: 'ポート番号は 1024〜65535 の整数で入力してください' });
  if (s.youtube.videos.length > 10) errors.push({ field: 'ytVideo', message: '配信の URL は 10 件までにしてください' });
  const badVideo = s.youtube.videos.find((v) => !extractVideoId(v));
  if (badVideo) errors.push({ field: 'ytVideo', message: `配信の URL または動画 ID が正しくありません：${badVideo}` });
  if (!Object.values(s.youtube.categories).some(Boolean)) errors.push({ field: 'catSuperchat', message: '取得するコメントを 1 つ以上選んでください' });
  if (!['web', 'api'].includes(s.youtube.source)) errors.push({ field: 'source', message: '取得方法を選んでください' });
  if (!['auto', 'fixed'].includes(s.youtube.pacing)) errors.push({ field: 'pacing', message: '取得間隔の決め方を選んでください' });
  if (!Number.isInteger(s.youtube.dailyQuota) || s.youtube.dailyQuota < 100) errors.push({ field: 'ytQuota', message: '1日の上限は 100 以上の整数で入力してください' });
  if (s.youtube.minIntervalMs < 1000) errors.push({ field: 'ytInterval', message: '取得間隔は 1 秒以上にしてください' });
  if (s.singular.displaySeconds < 0) errors.push({ field: 'dispSec', message: '表示時間は 0 以上にしてください' });
  if (s.singular.gapSeconds < 0) errors.push({ field: 'gapSec', message: '間隔は 0 以上にしてください' });
  return errors;
}

function updateSettings(input) {
  const next = config.merge(settings, input);
  // 空欄で送られたキーは「変更なし」として扱う
  if (!input?.youtube?.apiKey) next.youtube.apiKey = settings.youtube.apiKey;
  if (!input?.singular?.appToken) next.singular.appToken = settings.singular.appToken;
  if (input?.youtube?.clearApiKey) next.youtube.apiKey = '';
  if (input?.singular?.clearAppToken) next.singular.appToken = '';
  if (!['127.0.0.1', '0.0.0.0'].includes(next.host)) next.host = '127.0.0.1';
  const errors = validate(next);
  if (errors.length) return { errors };
  const autoTurnedOn = !settings.singular.autoSend && next.singular.autoSend;
  const restartRequired = next.port !== settings.port || next.host !== settings.host;
  const sourceChanged = next.youtube.source !== settings.youtube.source;
  const streamsChanged = sourceChanged || next.youtube.videos.join('\n') !== settings.youtube.videos.join('\n');
  settings = next;
  config.save(settings);
  if (streamsChanged) {
    // 配信の URL・取得方法が変わったら作り直す（取得中なら新しい一覧で取得し直す）
    if (sourceChanged) streams.rebuild(settings.youtube.videos, { force: true });
    if (wantRunning && settings.youtube.videos.length) {
      startChat().catch(() => broadcast('youtube', ytStatus()));
    } else {
      streams.rebuild(settings.youtube.videos);
      broadcast('youtube', ytStatus());
    }
  } else {
    streams.updateOptions(settings.youtube);
  }
  if (autoTurnedOn) cg.kick();
  broadcast('settings', publicSettings());
  return { settings: publicSettings(), restartRequired };
}

const chatOptions = () => ({
  apiKey: settings.youtube.apiKey,
  pacing: settings.youtube.pacing,
  minIntervalMs: settings.youtube.minIntervalMs,
  dailyQuota: settings.youtube.dailyQuota,
  skipBacklog: settings.youtube.skipBacklog,
});
const sourceLabel = () => (settings.youtube.source === 'api' && !DEMO ? 'API' : '直接取得');

// 設定の URL 一覧で作り直して、すべての配信の取得を始める（1 つでも始められれば成功）
async function startChat() {
  if (!settings.youtube.videos.length) throw new Error('配信の URL が未設定です（設定画面で入力してください）');
  streams.rebuild(settings.youtube.videos);
  const results = await streams.startAll(chatOptions());
  const multi = results.length > 1;
  for (const r of results) {
    const who = multi ? `配信${r.index}` : '';
    if (r.error) log(`${who ? `${who}：` : ''}取得を開始できませんでした（30秒ごとに再試行します）：${r.error.message}`, 'error');
    else log(`YouTube の取得を開始しました（${sourceLabel()}）：${who ? `${who} ` : ''}${r.title}`);
  }
  if (results.every((r) => r.error)) throw results[0].error;
}

// 止まっている配信があれば 30 秒ごとに再接続を試みる（停止ボタンを押すまで続ける）
const lastRetryErrors = new Map();
async function watchdog() {
  if (!wantRunning) return;
  // アプリ起動直後など、まだ一度も作っていなければ作り直して開始
  if (!streams.list.some((e) => e.started)) {
    try {
      await startChat();
    } catch {
      broadcast('youtube', ytStatus());
    }
    return;
  }
  for (const entry of streams.stopped()) {
    // 一度も始められていない配信（配信前など）は、初回として「取得開始より前のコメント」の設定に従う
    const err = await streams.startOne(entry, chatOptions(), { reconnect: entry.started });
    const who = streams.list.length > 1 ? `配信${entry.index}` : 'YouTube';
    if (!err) {
      log(`${who} の取得を再開しました：${entry.chat.status().title}`);
      lastRetryErrors.delete(entry.index);
    } else if (err.message !== lastRetryErrors.get(entry.index)) {
      log(`${who} に再接続できませんでした（30秒ごとに再試行します）：${err.message}`, 'error');
      lastRetryErrors.set(entry.index, err.message);
    }
  }
  broadcast('youtube', ytStatus());
}
setInterval(watchdog, 30000);

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1e6) {
        reject(new Error('リクエストが大きすぎます'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('JSON の形式が正しくありません'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname === '/settings' ? 'settings.html' : decodeURIComponent(pathname.slice(1));
  const data = readPublic(rel);
  if (!data) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not Found');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(rel)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  res.end(req.method === 'HEAD' ? undefined : data);
}

function snapshot() {
  return {
    demo: DEMO,
    port: PORT,
    host: HOST,
    settings: publicSettings(),
    youtube: ytStatus(),
    cg: cg.state(),
    messages: history,
    logs: logs.slice(0, 50),
  };
}

const routes = {
  'GET /api/ping': () => ({ app: 'superchat-cg', version: APP_VERSION }),
  'GET /api/state': () => snapshot(),
  'GET /api/settings': () => ({ settings: publicSettings(), port: PORT, host: HOST, demo: DEMO }),
  'PUT /api/settings': (body) => updateSettings(body),

  'POST /api/youtube/start': async () => {
    await startChat();
    setWantRunning(true);
    return ytStatus();
  },
  'POST /api/youtube/stop': () => {
    setWantRunning(false);
    streams.stopAll();
    log('YouTube の取得を停止しました');
    return ytStatus();
  },

  'POST /api/cg/send': (body) => {
    const msg = findMessage(body.id);
    if (!msg) throw Object.assign(new Error('コメントが見つかりません'), { status: 404 });
    cg.sendNow(msg);
    return cg.state();
  },
  'POST /api/cg/queue': (body) => {
    const msg = findMessage(body.id);
    if (!msg) throw Object.assign(new Error('コメントが見つかりません'), { status: 404 });
    cg.enqueue(msg);
    log(`キューに追加：${msg.name}`);
    return cg.state();
  },
  'POST /api/cg/out': () => {
    cg.out();
    return cg.state();
  },
  'POST /api/cg/next': () => {
    cg.playNext();
    return cg.state();
  },
  'POST /api/cg/top': (body) => {
    cg.moveToTop(body.id);
    return cg.state();
  },
  'POST /api/cg/remove': (body) => {
    cg.remove(body.id);
    return cg.state();
  },
  'POST /api/cg/clear': () => {
    cg.clearQueue();
    log('待機キューをすべて削除しました');
    return cg.state();
  },

  'POST /api/singular/test': async () => {
    const s = settings.singular;
    if (DEMO) return { ok: true, message: '[デモ] 接続テストは省略しました' };
    const r = await testConnection(s.appToken, s.subCompositionName);
    if (r.found === false) {
      return { ok: false, message: `接続できましたが、サブコンポジション「${s.subCompositionName}」が見つかりません。候補：${r.subCompositions.join('、')}` };
    }
    return { ok: true, message: `接続できました${r.found ? `。サブコンポジション「${s.subCompositionName}」が見つかりました` : ''}` };
  },
  'POST /api/singular/test-send': async () => {
    const msg = {
      id: `test-${Date.now()}`,
      type: 'superchat',
      name: 'テスト太郎',
      amount: '¥10,000',
      amountMicros: 10000e6,
      currency: 'JPY',
      comment: 'テスト送出です',
      icon: '',
      colors: { header: '#d00000', body: '#e62117', text: '#ffffff' },
      publishedAt: new Date().toISOString(),
    };
    const result = await new Promise((resolve) => {
      const done = (r) => {
        clearTimeout(timer);
        cg.off('sent', onSent);
        cg.off('error', onError);
        resolve(r);
      };
      const onSent = (m) => m.id === msg.id && done({ ok: true });
      const onError = (e) => done({ ok: false, message: e.message });
      const timer = setTimeout(() => done({ ok: false, message: '応答がありません（10 秒）' }), 10000);
      cg.on('sent', onSent);
      cg.on('error', onError);
      cg.sendNow(msg);
    });
    if (!result.ok) {
      cg.remove(msg.id); // テストデータはキューに残さない
      return { ok: false, message: result.message };
    }
    return { ok: true, message: 'テストデータを送出しました。Singular の出力を確認してください', payload: buildPayload(msg, settings.singular.fields, settings.singular) };
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;

  if (pathname === '/api/events' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(ping);
      clients.delete(res);
    });
    return;
  }

  const handler = routes[`${req.method} ${pathname}`];
  if (handler) {
    try {
      const body = req.method === 'GET' ? {} : await readBody(req);
      const result = await handler(body);
      sendJson(res, result?.errors ? 400 : 200, result ?? {});
    } catch (e) {
      log(e.message, 'error');
      sendJson(res, e.status || 500, { error: e.message });
    }
    return;
  }

  if (pathname.startsWith('/api/')) {
    sendJson(res, 404, { error: 'Not Found' });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return;
  }
  serveStatic(req, res, pathname);
});

// exe をダブルクリックで起動した場合など、エラーで即座にウィンドウが閉じないよう Enter 待ちにする
function waitAndExit(code) {
  if (!process.stdin.isTTY) process.exit(code);
  console.log('Enter キーを押すと終了します');
  process.stdin.resume();
  process.stdin.once('data', () => process.exit(code));
}

// ポートが使用中なら、その場で別の番号を入力してもらう（入力された番号は設定に保存）
function askPort() {
  const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
  rl.question(`使うポート番号を入力して Enter（例：${PORT + 1}）：`, (answer) => {
    rl.close();
    const n = Number(answer.trim());
    if (!Number.isInteger(n) || n < 1024 || n > 65535) {
      console.log('1024〜65535 の整数で入力してください');
      askPort();
      return;
    }
    PORT = n;
    settings.port = n;
    config.save(settings);
    server.listen(PORT, HOST);
  });
}

// すでにこのアプリが同じポートで起動しているか
async function isOurApp(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(1500) });
    return (await res.json()).app === 'superchat-cg';
  } catch {
    return false;
  }
}

const REQUESTED_PORT = PORT;
server.on('error', async (e) => {
  let msg;
  if (e.code === 'EADDRINUSE') {
    // 二重起動なら、起動中のほうの操作画面を開いて終了
    if (PORT === REQUESTED_PORT && (await isOurApp(PORT))) {
      console.log(`スーパーチャットCG はすでに起動しています：http://localhost:${PORT}/`);
      if (IS_EXE && !args.noOpen) openBrowser(`http://localhost:${PORT}/`);
      setTimeout(() => process.exit(0), 500);
      return;
    }
    if (process.stdin.isTTY) {
      console.error(`\nポート ${PORT} は他のアプリが使用中です。`);
      askPort();
      return;
    }
    // ウィンドウがないので番号は聞かず、空いているポートを自動で探す
    if (GUI && PORT < REQUESTED_PORT + 20) {
      console.log(`ポート ${PORT} は使用中のため ${PORT + 1} を試します`);
      PORT += 1;
      server.listen(PORT, HOST);
      return;
    }
    msg = `ポート ${PORT} は他のアプリが使用中です。別のポートを指定して起動してください。例：node server.js --port ${PORT + 1}`;
  } else if (e.code === 'EACCES') {
    msg = `ポート ${PORT} を使う権限がありません。1024 以上の番号を指定してください。`;
  } else {
    msg = `起動できませんでした：${e.message}`;
  }
  console.error(`\n${msg}\n`);
  if (GUI) {
    showMessage(msg);
    setTimeout(() => process.exit(1), 3000);
    return;
  }
  waitAndExit(1);
});

function openBrowser(url) {
  const { spawn } = require('child_process');
  const [cmd, cmdArgs] = process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    spawn(cmd, cmdArgs, { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref();
  } catch {
    // ブラウザを開けなくても動作は続ける
  }
}

server.on('listening', () => {
  console.log('\nスーパーチャットCG を起動しました' + (DEMO ? '（デモモード：YouTube / Singular には接続しません）' : ''));
  console.log(`  操作画面: http://localhost:${PORT}/`);
  console.log(`  設定画面: http://localhost:${PORT}/settings`);
  if (HOST === '0.0.0.0') {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const n of list || []) {
        if (n.family === 'IPv4' && !n.internal) console.log(`  他の端末から: http://${n.address}:${PORT}/`);
      }
    }
  }
  console.log(GUI ? '  終了はタスクトレイのアイコンを右クリック →「終了」\n' : IS_EXE ? '  終了するにはこのウィンドウを閉じてください\n' : '  終了するには Ctrl + C\n');
  if ((IS_EXE && !args.noOpen) || args.open) openBrowser(`http://localhost:${PORT}/`);
  if (GUI && !args.noTray) {
    const notice = PORT !== REQUESTED_PORT
      ? `ポート ${REQUESTED_PORT} が使用中のため ${PORT} で起動しました`
      : 'タスクトレイで動作中です。右クリックでメニューを開きます';
    startTray({ url: `http://localhost:${PORT}/`, exePath: process.execPath, logPath: LOG_PATH, notice });
  }
  if (wantRunning) {
    log('前回の取得を再開します');
    watchdog();
  }
});

process.on('uncaughtException', (e) => log(`内部エラー（動作は継続します）：${e.stack || e.message}`, 'error'));
process.on('unhandledRejection', (e) => log(`内部エラー（動作は継続します）：${e?.stack || e}`, 'error'));

function shutdown() {
  streams.stopAll();
  server.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, HOST);
