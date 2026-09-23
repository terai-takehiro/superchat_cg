'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const config = require('./lib/config');
const { YouTubeLiveChat } = require('./lib/youtube');
const { QuotaTracker } = require('./lib/quota');
const { YouTubeWebChat } = require('./lib/youtube-web');
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
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(`使い方: node server.js [--port 3000] [--host 127.0.0.1] [--demo]
  --port, -p  待ち受けポート番号（未指定時は設定画面の値、既定 3000）
  --host      待ち受けアドレス（0.0.0.0 で同じネットワークの他端末からも操作可）
  --demo      YouTube / Singular に接続せず、ダミーデータで動作確認する`);
  process.exit(0);
}

let settings = config.load();
const PORT = Number(args.port || process.env.PORT || settings.port) || 3000;
const HOST = args.host || process.env.HOST || settings.host || '127.0.0.1';
const DEMO = Boolean(args.demo);

// ---------- 状態 ----------
const MAX_HISTORY = 500;
let history = []; // 新しい順
const logs = [];

// 取得方法：web = YouTube から直接（上限なし） / api = YouTube Data API（1日の上限あり）
const sources = DEMO ? { demo: new DemoChat() } : { web: new YouTubeWebChat(), api: new YouTubeLiveChat(new QuotaTracker()) };
const sourceFor = () => (DEMO ? sources.demo : sources[settings.youtube.source] || sources.web);
let chat = sourceFor();
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
  if (settings.youtube.mode === 'superchat' && msg.type === 'text') return;
  msg.sent = false;
  history.unshift(msg);
  if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
  broadcast('message', msg);
  if (msg.type !== 'text' && settings.singular.autoSend) cg.enqueue(msg);
}
let lastYtError = '';
function onChatStatus(s) {
  broadcast('youtube', s);
  if (s.lastError && s.lastError !== lastYtError) {
    if (!s.running) log(`YouTube の取得が止まりました：${s.lastError}`, 'error');
    else log(`YouTube：${s.lastError}`, 'error');
  }
  lastYtError = s.lastError;
}
for (const src of Object.values(sources)) {
  // 使っていない取得方法からのイベントは無視する
  src.on('message', (m) => src === chat && onChatMessage(m));
  src.on('status', (st) => src === chat && onChatStatus(st));
}

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
  if (!['superchat', 'all'].includes(s.youtube.mode)) errors.push({ field: 'fetchMode', message: '取得するコメントを選んでください' });
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
  settings = next;
  config.save(settings);
  for (const src of Object.values(sources)) src.updateOptions(settings.youtube);
  if (autoTurnedOn) cg.kick();
  broadcast('settings', publicSettings());
  return { settings: publicSettings(), restartRequired };
}

// ---------- HTTP ----------
const PUBLIC_DIR = path.join(__dirname, 'public');
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
  const rel = pathname === '/' ? 'index.html' : pathname === '/settings' ? 'settings.html' : pathname.slice(1);
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

function snapshot() {
  return {
    demo: DEMO,
    port: PORT,
    host: HOST,
    settings: publicSettings(),
    youtube: chat.status(),
    cg: cg.state(),
    messages: history,
    logs: logs.slice(0, 50),
  };
}

const routes = {
  'GET /api/state': () => snapshot(),
  'GET /api/settings': () => ({ settings: publicSettings(), port: PORT, host: HOST, demo: DEMO }),
  'PUT /api/settings': (body) => updateSettings(body),

  'POST /api/youtube/start': async () => {
    chat.stop();
    chat = sourceFor();
    await chat.start({
      apiKey: settings.youtube.apiKey,
      video: settings.youtube.video,
      pacing: settings.youtube.pacing,
      minIntervalMs: settings.youtube.minIntervalMs,
      dailyQuota: settings.youtube.dailyQuota,
      skipBacklog: settings.youtube.skipBacklog,
    });
    log(`YouTube の取得を開始しました（${settings.youtube.source === 'api' && !DEMO ? 'API' : '直接取得'}）：${chat.status().title}`);
    return chat.status();
  },
  'POST /api/youtube/stop': () => {
    chat.stop();
    log('YouTube の取得を停止しました');
    return chat.status();
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
    return { ok: true, message: 'テストデータを送出しました。Singular の出力を確認してください', payload: buildPayload(msg, settings.singular.fields) };
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

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\nポート ${PORT} は他のアプリが使用中です。別のポートを指定して起動してください。\n  例：node server.js --port ${PORT + 1}\n`);
  } else if (e.code === 'EACCES') {
    console.error(`\nポート ${PORT} を使う権限がありません。1024 以上の番号を指定してください。\n`);
  } else {
    console.error(e);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
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
  console.log('  終了するには Ctrl + C\n');
});

function shutdown() {
  chat.stop();
  server.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
