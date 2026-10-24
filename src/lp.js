// Kiểm tra thanh khoản (LP) của 1 token có bị khoá/đốt hay không: ai đang giữ LP token của pool PancakeSwap V2.
// LP nằm ở ví thường = chủ ví rút thanh khoản được bất cứ lúc nào (rug). Đã đốt = không ai rút được.
// Pool V3 (LP là NFT vị thế) chưa đọc được tự động: bot báo để bạn tự kiểm tra.
import { Interface, getAddress, ZeroAddress } from 'ethers';
import { TOPIC, tryCall, getLogsChunked, topicToAddress } from './chain.js';

const V2_FACTORY = '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73';
const V3_FACTORY = '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865';
const QUOTES = { WBNB: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', USDT: '0x55d398326f99059fF775485246999027B3197955' };
const DEAD = ['0x000000000000000000000000000000000000dEaD', ZeroAddress].map((a) => a.toLowerCase());

const fI = new Interface(['function getPair(address,address) view returns (address)']);
const f3I = new Interface(['function getPool(address,address,uint24) view returns (address)']);
const pI = new Interface(['function totalSupply() view returns (uint256)', 'function balanceOf(address) view returns (uint256)']);

const pct = (a, t) => (t > 0n ? Number((a * 10000n) / t) / 100 : 0);

export async function lpLock(provider, token, { quote, blocks = 600_000, chunk = 5000, deadlineMs = 25_000 } = {}) {
  token = getAddress(token);
  const quotes = { ...(quote ? { QUOTE: getAddress(quote) } : {}), ...QUOTES };
  let pair = null;
  let quoteName = null;
  for (const [name, q] of Object.entries(quotes)) {
    if (q.toLowerCase() === token.toLowerCase()) continue;
    const p = await tryCall(provider, V2_FACTORY, fI, 'getPair', [token, q]);
    if (p && p !== ZeroAddress) { pair = p; quoteName = name; break; }
  }
  const v3 = [];
  for (const [name, q] of Object.entries(quotes)) {
    for (const fee of [100, 500, 2500, 10000]) {
      const p = await tryCall(provider, V3_FACTORY, f3I, 'getPool', [token, q, fee]);
      if (p && p !== ZeroAddress) v3.push({ pool: p, quote: name, fee });
    }
  }
  if (!pair) return { token, pair: null, v3, verdict: v3.length ? 'v3' : 'none', note: v3.length ? 'Chỉ có pool PancakeSwap V3: LP là NFT vị thế, bot chưa đọc được khoá. Tự kiểm tra ai giữ NFT vị thế trên BscScan.' : 'Không thấy pool PancakeSwap (V2/V3) với BNB/USDT.' };

  const total = (await tryCall(provider, pair, pI, 'totalSupply')) ?? 0n;
  // Ai đã nhận LP token: đọc log Transfer của pair, rồi hỏi số dư hiện tại.
  const head = await provider.getBlockNumber();
  const logs = await getLogsChunked(provider, { address: pair, topics: [TOPIC.TRANSFER] }, Math.max(0, head - blocks), head, chunk, { deadlineMs }).catch(() => []);
  const who = new Set(DEAD);
  for (const l of logs) if (l.topics.length === 3) who.add(topicToAddress(l.topics[2]).toLowerCase());
  who.delete(pair.toLowerCase());
  const rows = [];
  for (const a of [...who].slice(0, 60)) {
    const bal = (await tryCall(provider, pair, pI, 'balanceOf', [a])) ?? 0n;
    if (bal === 0n) continue;
    const code = DEAD.includes(a) ? '0x' : await provider.getCode(a).catch(() => '0x');
    rows.push({ address: getAddress(a), pct: pct(bal, total), kind: DEAD.includes(a) ? 'burned' : code !== '0x' ? 'contract' : 'wallet' });
  }
  rows.sort((a, b) => b.pct - a.pct);
  const sum = (k) => Math.round(rows.filter((r) => r.kind === k).reduce((s, r) => s + r.pct, 0) * 100) / 100;
  const burned = sum('burned');
  const contract = sum('contract');
  const wallet = sum('wallet');
  const verdict = wallet > 5 ? 'unlocked' : burned >= 95 ? 'burned' : burned + contract >= 95 ? 'contract' : logs.incomplete ? 'unknown' : 'mixed';
  const note = {
    unlocked: `⚠ Ví thường đang giữ ${wallet}% LP: người đó rút thanh khoản được bất cứ lúc nào.`,
    burned: `✓ ${burned}% LP đã đốt: không ai rút được thanh khoản. Giá vẫn có thể giảm nếu có người bán token.`,
    contract: `LP nằm trong hợp đồng (${contract}%${burned ? `, đốt ${burned}%` : ''}): có thể là hợp đồng khoá (locker). Mở hợp đồng trên BscScan để xem hạn khoá.`,
    unknown: 'Chưa đọc hết lịch sử LP (RPC giới hạn): kết quả có thể thiếu, thử lại hoặc dùng RPC riêng.',
    mixed: `LP chia nhiều nơi: đốt ${burned}%, hợp đồng ${contract}%, ví thường ${wallet}%.`,
  }[verdict];
  return { token, pair, quote: quoteName, v3, holders: rows.slice(0, 8), burned, contract, wallet, verdict, note, incomplete: Boolean(logs.incomplete) };
}
