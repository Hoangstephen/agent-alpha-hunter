#!/bin/bash
# Bấm đúp để chạy bot trên Mac.
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v npm >/dev/null; then
  echo ""
  echo "Máy chưa có Node.js (cần để chạy bot)."
  echo "1) Trang nodejs.org vừa mở: tải bản LTS (nút bên trái), cài như app bình thường."
  echo "2) Cài xong, bấm đúp lại start.command."
  open "https://nodejs.org/"
  read -p "Bấm Enter để đóng..."
  exit 1
fi
[ -d node_modules ] || npm install || { read -p "Cài thư viện lỗi. Bấm Enter để đóng..."; exit 1; }
if ! command -v baw >/dev/null; then
  npm i -g @binance/agentic-wallet@1.11.0 || {
    echo "Cần mật khẩu Mac để cài ví Binance (baw) cho toàn máy:"
    sudo npm i -g @binance/agentic-wallet@1.11.0
  }
fi
npm start
read -p "Bot đã dừng. Bấm Enter để đóng..."
