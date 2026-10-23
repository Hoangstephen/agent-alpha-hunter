#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { loadConfig } from './config.js';
import { connect } from './chain.js';
import { scanAll } from './scanner.js';
import { inspectContract } from './risk.js';
import { mint } from './mint.js';

const HELP = `
Bot săn NFT alpha (BNB Chain) — dùng Binance Agentic Wallet qua CLI baw

  npm start                                  Mở giao diện web (khuyên dùng)
  node src/index.js scan                     Quét tín hiệu (mint on-chain, gang.fun, X) + chấm rủi ro
  node src/index.js watch --every 10         Quét lặp lại mỗi N phút, chỉ báo, không mint
  node src/index.js inspect <0xHợpĐồng>      Kiểm tra rủi ro 1 hợp đồng
  node src/index.js mint <0xHợpĐồng> [--fn "mint(uint256)"] [--args '[1]'] [--value-bnb 0.01]
        [--qty 2] [--accept-risk: cho phép điểm an toàn 40–59 khi bạn đã tự kiểm tra] mặc định DRY-RUN | --preview: Binance mô phỏng | --live: mint thật (phải gõ xác nhận)

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
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: 'string', default: 'config.json' },
      fn: { type: 'string' }, qty: { type: 'string', default: '1' }, args: { type: 'string' }, 'value-bnb': { type: 'string' }, 'accept-risk': { type: 'boolean' },
      preview: { type: 'boolean' }, live: { type: 'boolean' },
      every: { type: 'string', default: '10' }, help: { type: 'boolean', short: 'h' },
    },
  });
  const [cmd, target] = positionals;
  if (!cmd || values.help) return console.log(HELP);
  const cfg = loadConfig(values.config);
  const provider = await connect(cfg);

  if (cmd === 'scan') await scan(provider, cfg);
  else if (cmd === 'watch') {
    for (;;) {
      await scan(provider, cfg);
      await sleep(Number(values.every) * 60_000);
    }
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
