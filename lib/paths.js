'use strict';

// 実行形態による違いをまとめる
// - 通常：node server.js（ファイルはプロジェクトフォルダに置く）
// - exe：Node.js の単一実行ファイル（SEA）。画面ファイルは exe に埋め込み、設定は exe と同じフォルダに保存
const fs = require('fs');
const path = require('path');

let sea = null;
try {
  const mod = require('node:sea');
  if (mod.isSea()) sea = mod;
} catch {
  // SEA 非対応の Node.js
}

const IS_EXE = Boolean(sea);
const APP_DIR = IS_EXE ? path.dirname(process.execPath) : path.join(__dirname, '..');

// public/ 以下のファイルを読む（見つからなければ null）
function readPublic(rel) {
  const clean = path.posix.normalize(rel).replace(/^(\.\.(\/|$))+/, '');
  if (clean.startsWith('/') || clean.split('/').includes('..')) return null;
  if (IS_EXE) {
    try {
      return Buffer.from(sea.getAsset(`public/${clean}`));
    } catch {
      return null;
    }
  }
  try {
    return fs.readFileSync(path.join(APP_DIR, 'public', clean));
  } catch {
    return null;
  }
}

module.exports = { IS_EXE, APP_DIR, dataPath: (name) => path.join(APP_DIR, name), readPublic };
