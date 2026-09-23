# スーパーチャットCG

YouTube Live のスーパーチャット（＋通常コメント）をリアルタイム取得し、Singular Live の CG に反映するローカル Web アプリ。

## 現状

- `mockup/index.html` … 操作画面のモックアップ（ダミーデータで動作。ブラウザで直接開けます）
- `mockup/settings.html` … 設定画面のモックアップ
- UI はデジタル庁デザインシステムを参考。タッチ操作前提で、送出は「コメントを選択 → 送出ボタン」の2段階
- `lib/` … バックエンドの下書き（YouTube Data API v3 取得／Singular Control App API 送出キュー）。未接続・未検証

## 予定仕様

- Node.js（18 以上）のみで動作、依存パッケージなし
- `node server.js --port 3001` でポート指定（設定画面からも変更可・再起動で反映）
- API Key / Token はアプリ画面で入力し、ローカルの `config.json` に保存（git 管理外）
- 取得モード：スパチャのみ / 全コメント
- 送出：自動（スパチャをキュー順に In → 表示秒数後 Out）/ 手動
