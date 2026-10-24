#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { loadConfig } from './config.js';
import { connect } from './chain.js';
import { scanAll } from './scanner.js';
import { inspectContract } from './risk.js';
import { mint } from './mint.js';
import { telegramConfig, telegramReady, saveTelegram, findChats, sendTelegram, notifyScan } from './telegram.js';

const HELP = `
Bot săn NFT alpha (BNB Chain) — dùng Binance Agentic Wallet qua CLI baw

  npm start                                  Mở giao diện web (khuyên dùng)
  node src/index.js scan                     Quét tín hiệu (mint on-chain, gang.fun, X) + chấm rủi ro
  node src/index.js watch --every 10         Quét lặp lại mỗi N phút, chỉ báo, không mint
  node src/index.js inspect <0xHợpĐồng>      Kiểm tra rủi ro 1 hợp đồng
  node src/index.js mint <0xHợpĐồng> [--fn "mint(uint256)"] [--args '[1]'] [--value-bnb 0.01]
        [--qty 2] [--accept-risk: cho phép điểm an toàn 40–59 khi bạn đã tự kiểm tra] mặc định DRY-RUN | --preview: Binance mô phỏng | --live: mint thật (phải gõ xác nhận)

  Chạy trên VPS (terminal, không cần giao diện) + báo về Telegram:
  node src/index.js telegram-setup --token <TOKEN>   Lưu bot Telegram (tạo bằng @BotFather), tự lấy chat id, gửi tin thử
  node src/index.js vps [--every 5]                  Quét liên tục mỗi N phút, in bảng ra terminal, báo NFT hot/gem về Telegram
        (chỉ báo, KHÔNG mint: mint luôn cần bạn tự xác nhận trên giao diện)

  --config <file>   (mặc định config.json)
`;

async function scan(provider, cfg) {
  const { nfts, tokens } = await scanAll(provider, cfg);
  console.log('\n=== NFT đang mint nóng (BSC) ===');
  console.table(nfts.map((n) => ({
    contract: n.address, name: n.name ?? '?', giá: n.priceBNB ?? '?', 'tối đa/ví': n.maxPerWallet ?? '?',
    minters: n.uniqueMinters, 'agent%': Math.round((n.agentRatio ?? 0) * 100), x: n.xMentions, hot: n.hot, 'an toàn': n.risk ?? '-',
  })));
  console.log('\n=== Token mới trên gang.fun (agent-only, mua bằng `gang` CLI) ===');
  console.table(tokens.slice(0, 10).map((t) => ({ token: t.address, name: t.name, symbol: t.symbol })));
  mkdirSync('reports', { recursive: true });
  const file = `reports/signals-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  writeFileSync(file, JSON.stringify({ nfts, tokens }, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
  console.log(`\nĐã lưu ${file}.`);
  return { nfts, tokens };
}

// Chế độ VPS: quét lặp, in gọn ra terminal, báo Telegram. Lỗi 1 lượt không làm dừng bot.
async function vps(provider, cfg, everyMin) {
  const t = telegramConfig(cfg);
  console.log(`[vps] quét mỗi ${everyMin} phút · Telegram: ${telegramReady(t) ? `bật (Hot ≥ ${t.minHot} hoặc Gem)` : 'TẮT (chạy telegram-setup để bật)'}`);
  if (telegramReady(t)) await sendTelegram(t, '🦅 Agent Alpha Hunter đã chạy trên VPS. Bot sẽ báo NFT hot / hidden gem tại đây.').catch((e) => console.log(`[telegram] ${e.message}`));
  let stop = false;
  process.on('SIGINT', () => { if (stop) process.exit(0); stop = true; console.log('\n[vps] dừng sau lượt này (Ctrl+C lần nữa để thoát ngay)'); });
  process.on('SIGTERM', () => process.exit(0));
  while (!stop) {
    const t0 = Date.now();
    try {
      const r = await scanAll(provider, cfg, (m) => console.log(`${new Date().toLocaleTimeString()} ${m}`));
      console.table(r.nfts.slice(0, 12).map((n) => ({ name: (n.name ?? '?').slice(0, 24), contract: n.address, hot: n.hot, gem: n.gem ? '💎' : '', 'giá BNB': n.priceBNB ?? '?', 'đã mint': n.minted ?? n.mints ?? '?', 'an toàn': n.risk ?? '-', nhái: n.lookalike ? '⚠' : '' })));
      await notifyScan(r, cfg, console.log);
    } catch (e) {
      console.log(`[vps] lỗi lượt quét: ${e.shortMessage || e.message}`);
    }
    const wait = Math.max(5_000, everyMin * 60_000 - (Date.now() - t0));
    for (let i = 0; i < wait / 1000 && !stop; i++) await sleep(1000);
  }
}

async function telegramSetup(token) {
  if (!token) return console.log('Dùng: node src/index.js telegram-setup --token <TOKEN từ @BotFather>');
  const chats = await findChats(token);
  if (!chats.length) return console.log('Chưa thấy tin nhắn nào. Mở Telegram, nhắn bất kỳ chữ gì cho bot của bạn (hoặc thêm bot vào nhóm và nhắn trong nhóm), rồi chạy lại lệnh này.');
  const c = chats.at(-1);
  saveTelegram({ botToken: token, chatId: c.id });
  await sendTelegram({ token, chatId: c.id }, '✅ Agent Alpha Hunter đã kết nối. Bot sẽ báo NFT hot / hidden gem tại đây.');
  console.log(`Đã lưu vào data/telegram.json · chat: ${c.name} (${c.id}). Đã gửi tin thử.${chats.length > 1 ? ' Có nhiều chat, bot chọn chat mới nhất: ' + chats.map((x) => `${x.name}=${x.id}`).join(', ') : ''}`);
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: 'string', default: 'config.json' },
      fn: { type: 'string' }, qty: { type: 'string', default: '1' }, args: { type: 'string' }, 'value-bnb': { type: 'string' }, 'accept-risk': { type: 'boolean' },
      preview: { type: 'boolean' }, live: { type: 'boolean' },
      every: { type: 'string' }, token: { type: 'string' }, help: { type: 'boolean', short: 'h' },
    },
  });
  const [cmd, target] = positionals;
  if (!cmd || values.help) return console.log(HELP);
  if (cmd === 'telegram-setup') return telegramSetup(values.token);
  const cfg = loadConfig(values.config);
  const provider = await connect(cfg);

  if (cmd === 'scan') await scan(provider, cfg);
  else if (cmd === 'watch') {
    for (;;) {
      await notifyScan(await scan(provider, cfg), cfg).catch(() => {});
      await sleep(Number(values.every ?? 10) * 60_000);
    }
  } else if (cmd === 'vps' || cmd === 'bot') {
    await vps(provider, cfg, Math.max(1, Number(values.every ?? 5)));
  } else if (cmd === 'inspect') {
    const r = await inspectContract(provider, target, cfg);
    console.log(JSON.stringify({ ...r, abi: undefined }, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
  } else if (cmd === 'mint') {
    await mint(provider, cfg, target, { fn: values.fn, args: values.args, valueBnb: values['value-bnb'], qty: Number(values.qty), preview: values.preview, live: values.live, acceptRisk: values['accept-risk'] });
  } else console.log(HELP);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e.shortMessage || e.message); process.exit(1); });
}
