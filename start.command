#!/bin/bash
cd "$(dirname "$0")"
[ -d node_modules ] || npm install
command -v baw >/dev/null || npm i -g @binance/agentic-wallet@1.11.0
npm start
