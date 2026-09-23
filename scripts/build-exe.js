'use strict';

// Node.js の単一実行ファイル（SEA）機能で、アプリを 1 つの実行ファイルにまとめる。
// 実行したOS用のファイルができる（Windows で実行すると superchat-cg.exe）。
//   npm run build:exe
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const exeName = `superchat-cg${isWin ? '.exe' : ''}`;
const exePath = path.join(DIST, exeName);

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

// 1) サーバーとライブラリを 1 ファイルにまとめる
esbuild.buildSync({
  entryPoints: [path.join(ROOT, 'server.js')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: path.join(DIST, 'app.cjs'),
  logLevel: 'warning',
});

// 2) 画面ファイル（public/）を埋め込み用に登録
const assets = {};
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else assets[path.relative(ROOT, full).split(path.sep).join('/')] = full;
  }
})(path.join(ROOT, 'public'));

const seaConfig = path.join(DIST, 'sea-config.json');
fs.writeFileSync(seaConfig, JSON.stringify({
  main: path.join(DIST, 'app.cjs'),
  output: path.join(DIST, 'sea-prep.blob'),
  disableExperimentalSEAWarning: true,
  useCodeCache: false,
  useSnapshot: false,
  assets,
}, null, 2));
execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { stdio: 'inherit' });

// 3) Node.js 本体をコピーして、アプリを注入する
fs.copyFileSync(process.execPath, exePath);
if (isMac) execFileSync('codesign', ['--remove-signature', exePath], { stdio: 'inherit' });
execFileSync(process.execPath, [
  require.resolve('postject/dist/cli.js'),
  exePath,
  'NODE_SEA_BLOB',
  path.join(DIST, 'sea-prep.blob'),
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ...(isMac ? ['--macho-segment-name', 'NODE_SEA'] : []),
], { stdio: 'inherit' });
if (isMac) execFileSync('codesign', ['--sign', '-', exePath], { stdio: 'inherit' });

for (const f of ['app.cjs', 'sea-config.json', 'sea-prep.blob']) fs.rmSync(path.join(DIST, f));
console.log(`\n作成しました: ${path.relative(ROOT, exePath)} (${(fs.statSync(exePath).size / 1e6).toFixed(1)} MB)`);
