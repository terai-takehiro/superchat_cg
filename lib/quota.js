'use strict';

// YouTube Data API のクォータ（1日の使用量）を記録する。
// クォータは太平洋時間（America/Los_Angeles）の 0 時にリセットされる。
const fs = require('fs');
const path = require('path');

const { dataPath } = require('./paths');

const USAGE_PATH = dataPath('usage.json');
const TZ = 'America/Los_Angeles';

function pacificDay(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

// 次のリセット（太平洋時間 0 時）までのミリ秒
function msUntilReset(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', hour: 'numeric', minute: 'numeric', second: 'numeric' })
      .formatToParts(now)
      .map((p) => [p.type, Number(p.value)]),
  );
  const elapsed = (parts.hour * 3600 + parts.minute * 60 + parts.second) * 1000 + now.getMilliseconds();
  return 86400000 - elapsed;
}

class QuotaTracker {
  constructor(file = USAGE_PATH) {
    this.file = file;
    this.day = pacificDay();
    this.used = 0;
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (saved.day === this.day) this.used = Number(saved.used) || 0;
    } catch {
      // 初回起動
    }
  }

  _roll() {
    const today = pacificDay();
    if (today !== this.day) {
      this.day = today;
      this.used = 0;
    }
  }

  add(units) {
    this._roll();
    this.used += units;
    try {
      fs.writeFileSync(this.file, JSON.stringify({ day: this.day, used: this.used }));
    } catch {
      // 記録に失敗しても取得は続ける
    }
  }

  getUsed() {
    this._roll();
    return this.used;
  }

  resetAt() {
    return Date.now() + msUntilReset();
  }
}

module.exports = { QuotaTracker, msUntilReset, pacificDay };
