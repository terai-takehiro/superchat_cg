'use strict';

// --demo 起動時に YouTube の代わりに使うダミーのコメント発生源
const { EventEmitter } = require('events');
const { tierColors } = require('./youtube');

const NAMES = ['たなか', 'Sakura Ch.', 'ぽん太', 'ゆうき', 'Mika', 'やまだ太郎', 'Neko_neko', 'けんと', 'Aoi', 'しろくま'];
const TEXTS = ['こんばんは！', '今日も楽しみにしてました', 'いつも応援してます！！', '初見です', 'その話もっと聞きたい', 'おつかれさまです', 'ナイス！', 'BGMいいですね'];
const SC_TEXTS = ['いつも元気もらってます！少しですが応援です', '誕生日おめでとう！', 'グッズ代にしてください', '', '昨日の配信最高でした'];
const AMOUNTS = [100, 200, 500, 1000, 2000, 5000, 10000, 50000];
const pick = (a) => a[Math.floor(Math.random() * a.length)];

class DemoChat extends EventEmitter {
  constructor() {
    super();
    this.running = false;
    this.timer = null;
    this.seq = 0;
  }

  status() {
    return { running: this.running, videoId: 'demo', title: '【デモ】ダミー配信', channelTitle: 'デモ', lastError: '' };
  }

  async start() {
    this.stop();
    this.running = true;
    this.timer = setInterval(() => this.emit('message', this._make()), 2000);
    this.emit('status', this.status());
  }

  stop() {
    const was = this.running;
    clearInterval(this.timer);
    this.running = false;
    if (was) this.emit('status', this.status());
  }

  _make() {
    const sc = Math.random() < 0.3;
    const yen = pick(AMOUNTS);
    const name = pick(NAMES);
    const msg = {
      id: `demo-${Date.now()}-${++this.seq}`,
      type: sc ? 'superchat' : 'text',
      name,
      channelId: '',
      icon: '',
      isMember: Math.random() < 0.2,
      isModerator: false,
      isOwner: false,
      amount: sc ? `¥${yen.toLocaleString('ja-JP')}` : '',
      amountMicros: sc ? yen * 1e6 : 0,
      currency: sc ? 'JPY' : '',
      tier: null,
      comment: sc ? pick(SC_TEXTS) : pick(TEXTS),
      publishedAt: new Date().toISOString(),
    };
    if (sc) msg.colors = tierColors(msg);
    return msg;
  }
}

module.exports = { DemoChat };
