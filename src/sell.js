// Tìm giá bán cao nhất cho NFT bạn đang giữ.
// - Lệnh mua (offer) trên sàn Element: bán được ngay ở giá này (cần ELEMENT_API_KEY).
// - Giá bán gần đây trên chain: tham khảo, đọc từ giao dịch có chuyển NFT kèm trả BNB/WBNB/USDT.
// Đăng bán thật nằm ở list.js (ký lệnh Element bằng ví Agentic) và autosell.js (tự đăng theo quy tắc).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { getAddress, formatEther, Interface, zeroPadValue } from 'ethers';
import { TOPIC, tryCall, erc721, getLogsChunked, topicToAddress, mapLimit } from './chain.js';
import { STABLES } from './risk.js';
import { ADDR } from './config.js';
import { projectPage } from './rules.js';
import { findMarkets } from './markets.js';

const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
const USDT = '0x55d398326f99059ff775485246999027b3197955';

const ownerOfI = new Interface(['function ownerOf(uint256) view returns (address)']);
const ownedI = new Interface(['function tokensOfOwner(address) view returns (uint256[])', 'function tokensOfOwnerIn(address,uint256,uint256) view returns (uint256[])']);
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11'; // cùng địa chỉ trên mọi chain EVM
const mcI = new Interface(['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns ((bool success,bytes returnData)[])']);

// Hợp đồng không hỗ trợ liệt kê và RPC không đọc được log: hỏi ownerOf của từng số token (gộp 400 số / 1 lần gọi
// qua Multicall3), chỉ khi bộ NFT không quá lớn. Dừng khi đã đủ số NFT ví đang giữ.
export async function idsByOwnerScan(provider, contract, wallet, want, { maxSupply = 20_000, batch = 400, deadlineMs = 25_000 } = {}) {
  const total = Number((await tryCall(provider, contract, erc721, 'totalSupply')) ?? 0n);
  if (!total || total > maxSupply) return [];
  const me = wallet.toLowerCase();
  const found = [];
  const stopAt = Date.now() + deadlineMs;
  for (let a = 0; a <= total && found.length < want && Date.now() < stopAt; a += batch) {
    const ids = Array.from({ length: Math.min(batch, total + 1 - a) }, (_, i) => BigInt(a + i));
    const calls = ids.map((id) => ({ target: contract, allowFailure: true, callData: ownerOfI.encodeFunctionData('ownerOf', [id]) }));
    let res;
    try {
      [res] = mcI.decodeFunctionResult('aggregate3', await provider.call({ to: MULTICALL3, data: mcI.encodeFunctionData('aggregate3', [calls]) }));
    } catch { return found; }
    res.forEach((r, i) => {
      if (r.success && r.returnData.length >= 66 && ('0x' + r.returnData.slice(-40)).toLowerCase() === me) found.push(ids[i].toString());
    });
  }
  return found;
}

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
    // ERC721A thường có tokensOfOwner(ví).
    if (!ids.length) ids = [...((await tryCall(provider, c, ownedI, 'tokensOfOwner', [wallet])) ?? [])].slice(0, 20).map(String);
    if (!ids.length) {
      // Hợp đồng không hỗ trợ liệt kê: tìm id qua log nhận NFT của RIÊNG hợp đồng này (RPC dễ chấp nhận hơn log toàn mạng),
      // rồi kiểm tra lại chủ sở hữu hiện tại.
      let cand = [...(received.get(c) ?? [])];
      if (!cand.length) cand = [...await receivedFrom(provider, c, wallet, { deadlineMs }).catch(() => new Set())];
      cand = cand.slice(-40);
      const owners = await Promise.all(cand.map((id) => tryCall(provider, c, ownerOfI, 'ownerOf', [BigInt(id)])));
      ids = cand.filter((_, i) => owners[i] && owners[i].toLowerCase() === wallet.toLowerCase()).slice(0, 20);
    }
    if (!ids.length) ids = await idsByOwnerScan(provider, c, wallet, n, { deadlineMs }).catch(() => []);
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

export async function recentSales(provider, contract, { blocks = 6000, chunk = 2000, maxTx = 25, bnbUsdt, deadlineMs = 60_000, logs } = {}) {
  if (!logs) {
    const head = await provider.getBlockNumber();
    logs = await getLogsChunked(provider, { address: contract, topics: [TOPIC.TRANSFER] }, head - blocks, head, chunk, { concurrency: 6, deadlineMs });
  }
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

export async function sellReport(provider, cfg, wallet, contracts, { bnbUsdt, log, cachePath, mintTxs = [], sellCachePath = 'data/sell-cache.json' } = {}) {
  const [received, fromTxs] = await Promise.all([
    receivedNfts(provider, wallet, { chunk: cfg.scan.chunkByAddress ?? 2000, log, cachePath }).catch(() => new Map()),
    idsFromTxs(provider, wallet, mintTxs).catch(() => new Map()),
  ]);
  for (const [c, ids] of fromTxs) received.set(c, new Set([...(received.get(c) ?? []), ...ids]));
  // Agent ID (.ai) là NFT soulbound: không chuyển/bán được, bỏ khỏi danh sách bán.
  const holdings = (await holdingsOf(provider, wallet, contracts, { received })).filter((h) => h.contract.toLowerCase() !== ADDR.AGENT_ID_REGISTRY.toLowerCase());
  let element = { enabled: false, offers: new Map() };
  try { element = await elementOffers(cfg, wallet); } catch (e) { element.error = e.message; }

  // Kết quả tốt gần nhất mỗi bộ NFT (giá bán + chợ), dùng khi RPC lỗi lượt này.
  let sellCache = {};
  try { sellCache = JSON.parse(readFileSync(sellCachePath, 'utf8')); } catch {}
  await mapLimit(holdings, 2, async (h) => {
    // Giá bán trong ~1,5 ngày gần nhất (BSC ~0,75 giây/block), lọc theo hợp đồng nên RPC chịu được đoạn lớn.
    // Web dự án: nhiều dự án có chợ riêng và cho kết nối thẳng ví Agentic (Element thì không).
    // Log chuyển NFT ~1,5 ngày gần nhất: đọc 1 lần, dùng chung cho giá bán gần đây và tìm chợ riêng của bộ NFT.
    const head = await provider.getBlockNumber();
    const logs = await getLogsChunked(provider, { address: h.contract, topics: [TOPIC.TRANSFER] }, head - 180_000, head, 5000, { concurrency: 6, deadlineMs: 30_000 }).catch(() => null);
    const page = Promise.race([projectPage(provider, h.contract).catch(() => null), new Promise((r) => setTimeout(() => r(null), 8000))]);
    [h.site, h.markets, h.sales] = await Promise.all([
      page.then((p) => p?.site ?? null),
      logs ? Promise.race([findMarkets(provider, h.contract, { logs, page }).catch(() => []), new Promise((r) => setTimeout(() => r([]), 40_000))]) : [],
      logs ? recentSales(provider, h.contract, { logs, bnbUsdt }).catch(() => ({ count: 0 })) : { count: 0 },
    ]);
    // RPC lỗi / đọc thiếu lần này: dùng lại kết quả tốt gần nhất (tối đa 24 giờ), không báo nhầm "chưa ai bán".
    const prev = sellCache[h.contract.toLowerCase()];
    const fresh = prev && Date.now() - prev.at < 86400_000;
    if (!h.sales?.count && fresh && prev.sales?.count) Object.assign(h, { sales: prev.sales, salesCached: prev.at });
    if (!h.markets?.length && fresh && prev.markets?.length) Object.assign(h, { markets: prev.markets, marketsCached: prev.at });
    h.logsIncomplete = !logs || Boolean(logs.incomplete);
    const newSales = !h.salesCached && h.sales?.count;
    const newMarkets = !h.marketsCached && h.markets?.length;
    if (newSales || newMarkets) sellCache[h.contract.toLowerCase()] = { at: Date.now(), sales: newSales ? h.sales : prev?.sales, markets: newMarkets ? h.markets : prev?.markets };
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
  try { mkdirSync(dirname(sellCachePath), { recursive: true }); writeFileSync(sellCachePath, JSON.stringify(sellCache, (_, v) => (typeof v === 'bigint' ? v.toString() : v))); } catch {}
  return { wallet, elementEnabled: element.enabled, elementError: element.error, holdings };
}
