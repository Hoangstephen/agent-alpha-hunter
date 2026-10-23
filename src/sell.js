// Tìm giá bán cao nhất cho NFT bạn đang giữ.
// - Lệnh mua (offer) trên sàn Element: bán được ngay ở giá này (cần ELEMENT_API_KEY).
// - Giá bán gần đây trên chain: tham khảo, đọc từ giao dịch có chuyển NFT kèm trả BNB/WBNB/USDT.
// Bot KHÔNG tự đăng bán: đăng bán phải cấp setApprovalForAll cho sàn, đúng kiểu lừa của drainer,
// nên việc đó làm trên trang chính thức của sàn.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { getAddress, formatEther, Interface, zeroPadValue } from 'ethers';
import { TOPIC, tryCall, erc721, getLogsChunked, topicToAddress, mapLimit } from './chain.js';
import { STABLES } from './risk.js';

const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
const USDT = '0x55d398326f99059ff775485246999027b3197955';

const ownerOfI = new Interface(['function ownerOf(uint256) view returns (address)']);

// NFT (ERC-721) ví đã nhận, không cần biết trước hợp đồng: lọc log Transfer có người nhận = ví.
// Kết quả lưu ở data/wallet-nfts.json cùng đoạn block đã quét [lo, hi]. Mỗi lần bấm: quét phần block mới
// (sau hi), rồi quét lùi tiếp (trước lo) tới khi đủ `blocks` hoặc hết `deadlineMs`. Càng bấm càng đủ.
export async function receivedNfts(provider, wallet, { blocks = 1_200_000, chunk = 2000, deadlineMs = 45_000, cachePath = 'data/wallet-nfts.json', log = () => {} } = {}) {
  const key = wallet.toLowerCase();
  let cache = {};
  try { cache = JSON.parse(readFileSync(cachePath, 'utf8')); } catch {}
  const mine = cache[key] ?? { lo: null, hi: null, contracts: {} };
  const head = await provider.getBlockNumber();
  const floor = head - blocks;
  const stopAt = Date.now() + deadlineMs;
  const filter = { topics: [TOPIC.TRANSFER, null, zeroPadValue(wallet, 32)] };
  const add = (logs) => {
    for (const l of logs) {
      if (l.topics.length !== 4) continue; // ERC-20 có 3 topic
      const c = getAddress(l.address);
      const ids = new Set(mine.contracts[c] ?? []);
      ids.add(BigInt(l.topics[3]).toString());
      mine.contracts[c] = [...ids].slice(-200);
    }
  };
  // Một mẻ = 20 đoạn. Chỉ ghi nhận đoạn đã quét khi cả mẻ thành công, để không bỏ sót.
  const batch = async (a, b) => {
    const left = stopAt - Date.now();
    if (left < 2000) return false;
    try {
      const logs = await getLogsChunked(provider, filter, a, b, chunk, { concurrency: 6, deadlineMs: left });
      if (logs.incomplete) return false;
      add(logs);
      return true;
    } catch (e) {
      log(`[ví] lỗi đọc log: ${e.message}`);
      return false;
    }
  };
  const span = chunk * 20;
  let scanned = 0;
  if (mine.hi == null) { mine.hi = head; mine.lo = head + 1; }
  // 1) Block mới từ lần trước.
  for (let a = mine.hi + 1; a <= head; a += span) {
    const b = Math.min(a + span - 1, head);
    if (!(await batch(a, b))) break;
    mine.hi = b; scanned += b - a + 1;
  }
  // 2) Quét lùi về quá khứ.
  while (mine.lo > floor) {
    const b = mine.lo - 1;
    const a = Math.max(b - span + 1, floor);
    if (!(await batch(a, b))) break;
    mine.lo = a; scanned += b - a + 1;
  }
  cache[key] = mine;
  try { mkdirSync(dirname(cachePath), { recursive: true }); writeFileSync(cachePath, JSON.stringify(cache)); } catch {}
  const done = mine.lo <= floor && mine.hi >= head;
  log(`[ví] quét thêm ${scanned} block, đã phủ ${Math.max(0, mine.hi - mine.lo + 1)} block${done ? '' : ' (chưa hết, bấm lại để quét tiếp)'}: thấy ${Object.keys(mine.contracts).length} hợp đồng NFT`);
  return new Map(Object.entries(mine.contracts).map(([c, ids]) => [c, new Set(ids)]));
}

// Id NFT từ chính các giao dịch mint qua bot (đọc receipt), không cần quét log.
export async function idsFromTxs(provider, wallet, txs) {
  const by = new Map();
  const to = zeroPadValue(wallet, 32).toLowerCase();
  await mapLimit(txs.filter((t) => t.txHash), 4, async (t) => {
    const rc = await provider.getTransactionReceipt(t.txHash).catch(() => null);
    for (const l of rc?.logs ?? []) {
      if (l.topics[0] !== TOPIC.TRANSFER || l.topics.length !== 4 || l.topics[2].toLowerCase() !== to) continue;
      const c = getAddress(l.address);
      const ids = by.get(c) ?? new Set();
      ids.add(BigInt(l.topics[3]).toString());
      by.set(c, ids);
    }
  });
  return by;
}

export async function holdingsOf(provider, wallet, contracts, { received = new Map(), deadlineMs = 25_000 } = {}) {
  const all = [...new Set([...contracts.map((a) => getAddress(a)), ...received.keys()])];
  const rows = await mapLimit(all, 6, async (c) => {
    const bal = await tryCall(provider, c, erc721, 'balanceOf', [wallet]);
    if (!bal || bal === 0n) return null;
    const n = bal < 20n ? Number(bal) : 20;
    let ids = (await Promise.all(Array.from({ length: n }, (_, i) => tryCall(provider, c, erc721, 'tokenOfOwnerByIndex', [wallet, BigInt(i)])))).filter((x) => x !== null).map(String);
    if (!ids.length) {
      // Hợp đồng không hỗ trợ liệt kê: tìm id qua log nhận NFT của RIÊNG hợp đồng này (RPC dễ chấp nhận hơn log toàn mạng),
      // rồi kiểm tra lại chủ sở hữu hiện tại.
      let cand = [...(received.get(c) ?? [])];
      if (!cand.length) cand = [...await receivedFrom(provider, c, wallet, { deadlineMs }).catch(() => new Set())];
      cand = cand.slice(-40);
      const owners = await Promise.all(cand.map((id) => tryCall(provider, c, ownerOfI, 'ownerOf', [BigInt(id)])));
      ids = cand.filter((_, i) => owners[i] && owners[i].toLowerCase() === wallet.toLowerCase()).slice(0, 20);
    }
    return { contract: c, name: await tryCall(provider, c, erc721, 'name'), balance: bal.toString(), tokenIds: ids };
  });
  return rows.filter(Boolean);
}

// Id NFT mà ví đã nhận từ 1 hợp đồng (lọc theo địa chỉ hợp đồng + người nhận).
export async function receivedFrom(provider, contract, wallet, { blocks = 400_000, chunk = 5000, deadlineMs = 25_000 } = {}) {
  const head = await provider.getBlockNumber();
  const logs = await getLogsChunked(provider, { address: contract, topics: [TOPIC.TRANSFER, null, zeroPadValue(wallet, 32)] }, head - blocks, head, chunk, { concurrency: 6, deadlineMs });
  return new Set(logs.filter((l) => l.topics.length === 4).map((l) => BigInt(l.topics[3]).toString()));
}

// Hàm thuần: giá mỗi NFT của 1 giao dịch = tiền người bán nhận / số NFT trong giao dịch.
export function salePriceBNB({ txValueWei, receiptLogs, seller, nftCount, bnbUsdt }) {
  let wei = txValueWei ?? 0n;
  if (wei === 0n) {
    const toSeller = zeroPadValue(seller, 32).toLowerCase();
    for (const l of receiptLogs ?? []) {
      if (l.topics[0] !== TOPIC.TRANSFER || l.topics.length !== 3 || l.topics[2].toLowerCase() !== toSeller) continue;
      const amt = BigInt(l.data);
      const token = l.address.toLowerCase();
      if (token === WBNB) wei += amt;
      else if (token === USDT && bnbUsdt) wei += BigInt(Math.round((Number(formatEther(amt)) / bnbUsdt) * 1e18));
    }
  }
  if (wei === 0n || !nftCount) return null;
  return Number(formatEther(wei / BigInt(nftCount)));
}

// Hàm thuần: 1 giao dịch mint trả bao nhiêu cho mỗi NFT (BNB gửi kèm, hoặc stablecoin chuyển đi từ ví mint).
export function mintPaidBNB({ txValueWei, receiptLogs, minter, nftCount, bnbUsdt, gasUsed, gasPrice }) {
  let wei = txValueWei ?? 0n;
  let token = wei > 0n ? 'BNB' : null;
  const fromMinter = zeroPadValue(minter, 32).toLowerCase();
  let usd = 0;
  for (const l of receiptLogs ?? []) {
    if (l.topics[0] !== TOPIC.TRANSFER || l.topics.length !== 3 || l.topics[1].toLowerCase() !== fromMinter) continue;
    const sym = STABLES[l.address.toLowerCase()];
    if (sym) { usd += Number(formatEther(BigInt(l.data))); token = sym; }
    else if (l.address.toLowerCase() === WBNB) { wei += BigInt(l.data); token = 'WBNB'; }
  }
  const n = BigInt(nftCount || 1);
  const priceBNB = Number(formatEther(wei / n)) + (usd && bnbUsdt ? usd / bnbUsdt / Number(n) : 0);
  const gasBNB = gasUsed != null && gasPrice != null ? Number(formatEther((BigInt(gasUsed) * BigInt(gasPrice)) / n)) : null;
  return { priceBNB, gasBNB, token: token ?? 'free' };
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };

// Giá mint thực tế mọi người đang trả, đọc từ các giao dịch mint gần nhất.
export async function mintStats(provider, mintTxs, { bnbUsdt } = {}) {
  const rows = (await mapLimit(mintTxs, 5, async (t) => {
    const [tx, rc] = await Promise.all([provider.getTransaction(t.hash).catch(() => null), provider.getTransactionReceipt(t.hash).catch(() => null)]);
    if (!tx || !rc) return null;
    return mintPaidBNB({ txValueWei: tx.value, receiptLogs: rc.logs, minter: t.minter, nftCount: t.n, bnbUsdt, gasUsed: rc.gasUsed, gasPrice: rc.gasPrice ?? tx.gasPrice });
  })).filter(Boolean);
  if (!rows.length) return null;
  const tokens = [...new Set(rows.map((r) => r.token))];
  return {
    sampled: rows.length,
    free: rows.every((r) => r.priceBNB === 0),
    priceBNB: median(rows.map((r) => r.priceBNB)),
    gasBNB: median(rows.map((r) => r.gasBNB).filter((x) => x != null)),
    paidIn: tokens.filter((x) => x !== 'free').join('/') || 'free',
  };
}

export async function recentSales(provider, contract, { blocks = 6000, chunk = 2000, maxTx = 25, bnbUsdt, deadlineMs = 60_000 } = {}) {
  const head = await provider.getBlockNumber();
  const logs = await getLogsChunked(provider, { address: contract, topics: [TOPIC.TRANSFER] }, head - blocks, head, chunk, { concurrency: 6, deadlineMs });
  const byTx = new Map();
  for (const l of logs) {
    if (l.topics.length !== 4 || l.topics[1] === TOPIC.ZERO) continue; // bỏ mint và ERC-20
    const row = byTx.get(l.transactionHash) ?? { seller: topicToAddress(l.topics[1]), n: 0, block: l.blockNumber };
    row.n += 1;
    byTx.set(l.transactionHash, row);
  }
  const prices = (await mapLimit([...byTx].slice(-maxTx), 5, async ([hash, r]) => {
    const tx = await provider.getTransaction(hash).catch(() => null);
    if (!tx) return null;
    const receipt = tx.value > 0n ? null : await provider.getTransactionReceipt(hash).catch(() => null);
    const p = salePriceBNB({ txValueWei: tx.value, receiptLogs: receipt?.logs, seller: r.seller, nftCount: r.n, bnbUsdt });
    return p ? { price: p, tx: hash, block: r.block } : null;
  })).filter(Boolean);
  if (!prices.length) return { count: 0 };
  const sorted = prices.map((p) => p.price).sort((a, b) => a - b);
  return {
    count: prices.length,
    maxBNB: sorted.at(-1),
    medianBNB: median(sorted),
    lastBNB: prices.at(-1).price,
    lastTx: prices.at(-1).tx,
  };
}

// Element trả giá dạng số thập phân hoặc wei tuỳ API: đổi về BNB.
export const toBNB = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n > 1e9 ? n / 1e18 : n;
};

export async function elementOffers(cfg, wallet, fetchFn = fetch) {
  if (!cfg.elementKey) return { enabled: false, offers: new Map() };
  const url = `https://api.element.market/openapi/v1/account/offerReceived?chain=bsc&wallet_address=${wallet}&limit=50`;
  const j = await (await fetchFn(url, { headers: { 'X-Api-Key': cfg.elementKey, accept: 'application/json' }, signal: AbortSignal.timeout(8000) })).json();
  const offers = new Map();
  for (const it of j.data?.assetList ?? []) {
    const bid = it.orderData?.bestBid;
    const a = it.asset ?? {};
    const price = toBNB(bid?.price);
    const contract = a.contractAddress ?? a.contract ?? a.collection?.contractAddress;
    if (!price || !contract) continue;
    offers.set(`${contract.toLowerCase()}:${a.tokenId}`, { price, priceUSD: bid.priceUSD, maker: bid.maker });
  }
  return { enabled: true, offers };
}

export async function sellReport(provider, cfg, wallet, contracts, { bnbUsdt, log, cachePath, mintTxs = [] } = {}) {
  const [received, fromTxs] = await Promise.all([
    receivedNfts(provider, wallet, { chunk: cfg.scan.chunkByAddress ?? 2000, log, cachePath }).catch(() => new Map()),
    idsFromTxs(provider, wallet, mintTxs).catch(() => new Map()),
  ]);
  for (const [c, ids] of fromTxs) received.set(c, new Set([...(received.get(c) ?? []), ...ids]));
  const holdings = await holdingsOf(provider, wallet, contracts, { received });
  let element = { enabled: false, offers: new Map() };
  try { element = await elementOffers(cfg, wallet); } catch (e) { element.error = e.message; }

  await mapLimit(holdings, 3, async (h) => {
    // Giá bán trong ~1,5 ngày gần nhất (BSC ~0,75 giây/block), lọc theo hợp đồng nên RPC chịu được đoạn lớn.
    h.sales = await recentSales(provider, h.contract, { blocks: 180_000, chunk: 5000, bnbUsdt, deadlineMs: 25_000 }).catch(() => ({ count: 0 }));
    h.items = (h.tokenIds.length ? h.tokenIds : [null]).map((id) => {
      const offer = id != null ? element.offers.get(`${h.contract.toLowerCase()}:${id}`) : null;
      const options = [];
      if (offer) options.push({ venue: 'Element (lệnh mua, bán ngay được)', priceBNB: offer.price, instant: true, url: `https://element.market/assets/bsc/${h.contract}/${id}` });
      if (h.sales.maxBNB) options.push({ venue: `Giá bán cao nhất gần đây (${h.sales.count} giao dịch)`, priceBNB: h.sales.maxBNB, instant: false });
      if (h.sales.medianBNB) options.push({ venue: 'Giá bán trung vị gần đây', priceBNB: h.sales.medianBNB, instant: false });
      options.sort((a, b) => b.priceBNB - a.priceBNB);
      return { tokenId: id, best: options[0] ?? null, options, elementUrl: id != null ? `https://element.market/assets/bsc/${h.contract}/${id}` : null };
    });
  });
  return { wallet, elementEnabled: element.enabled, elementError: element.error, holdings };
}
