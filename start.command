#!/bin/sh
cd "$(dirname "$0")"
# ポート番号を変える場合は下の 3000 を書き換えてください
node server.js --port 3000
