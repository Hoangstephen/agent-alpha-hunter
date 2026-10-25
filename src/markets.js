// Chợ mua bán riêng của 1 bộ NFT (vd. agentpunk.fun cho Agent Nakamigos), không cần Element.
// 1) Tìm chợ: các giao dịch chuyển NFT gần đây đi qua hợp đồng nào (không phải chính hợp đồng NFT) thì đó là chợ.
// 2) Tin chợ: CHỈ khi chứng minh được chợ do chính đội dự án làm: owner() của chợ = owner() của hợp đồng NFT
//    (khác địa chỉ 0). Hợp đồng drainer cũng chuyển NFT của nhiều người y như chợ, nhưng không thể có cùng chủ
//    với dự án. Chợ không chứng minh được thì bot chỉ hiện link, không cấp quyền, không bán.
//    Thêm 2 cách tin (chỉ cấp quyền cho ĐÚNG 1 NFT, không bao giờ quyền cả bộ):
//    - web của dự án có ghi địa chỉ chợ (trong trang hoặc file JS của trang);
//    - chợ có ≥ 5 người mua khác nhau đã trả BNB thật qua chợ để mua NFT của ≥ 5 người bán khác nhau.
//    Quyền 1 NFT tự mất khi NFT được bán; drainer có lừa được cũng chỉ lấy được đúng NFT đó.
// 3) Bán ngay: chép đúng giao dịch người khác đã tự bán vào lệnh mua (offer) trên chợ đó (giống học cách mint),
//    thay số token + địa chỉ ví của họ bằng của bạn. Luôn qua mô phỏng + Binance preview + bạn bấm xác nhận.
import { Interface, getAddress, ZeroAddress } from 'ethers';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { TOPIC, getLogsChunked, topicToAddress, mapLimit, tryCall } from './chain.js';
import { verifiedSource, fetchText } from './rules.js';
import { ELEMENT } from './list.js';
import * as wallet from './baw.js';

const KNOWN = { [ELEMENT.EX.toLowerCase()]: { name: 'Element', site: 'https://element.market' } };
const ownI = new Interface(['function owner() view returns (address)']);
const nftI = new Interface(['function setApprovalForAll(address,bool)', 'function isApprovedForAll(address,address) view returns (bool)', 'function approve(address,uint256)', 'function getApproved(uint256) view returns (address)']);
export const PROVEN = { buyers: 5, sellers: 5 };
const pad = (a) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const word = (n) => BigInt(n).toString(16).padStart(64, '0');

// Chợ có cùng chủ (owner) với hợp đồng NFT không. Trả về lý do tin, hoặc null.
export async function trustOf(provider, nft, market) {
  const [a, b] = await Promise.all([tryCall(provider, nft, ownI, 'owner'), tryCall(provider, market, ownI, 'owner')]);
  if (a && b && a !== ZeroAddress && a.toLowerCase() === b.toLowerCase()) return { why: 'same-owner', owner: a };
  return null;
}

// Web của dự án có nhắc tới địa chỉ chợ không (trong HTML hoặc tối đa 8 file JS cùng tên miền).
export async function siteMentions(site, html, address, fetchFn = fetch) {
  const a = address.toLowerCase().slice(2);
  if (!site) return false;
  if (String(html ?? '').toLowerCase().includes(a)) return true;
  let base;
  try { base = new URL(site); } catch { return false; }
  const srcs = [...String(html ?? '').matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((m) => { try { return new URL(m[1], base); } catch { return null; } })
    .filter((u) => u && u.protocol === 'https:' && u.hostname.split('.').slice(-2).join('.') === base.hostname.split('.').slice(-2).join('.')).slice(0, 8);
  for (const u of srcs) {
    const t = await fetchText(u.href, fetchFn, 5_000_000).catch(() => null);
    if (t && t.toLowerCase().includes(a)) return true;
  }
  return false;
}

// Đủ bằng chứng là chợ thật: nhiều người mua khác nhau trả BNB qua chợ để mua NFT của nhiều người bán khác nhau.
export const provenMarket = (m) => (m?.buyers ?? 0) >= PROVEN.buyers && (m?.paidSellers ?? 0) >= PROVEN.sellers;

// Tin chợ theo thứ tự: cùng chủ (quyền cả bộ) > web dự án ghi địa chỉ chợ > chợ có người mua thật (quyền 1 NFT).
export async function trustMarket(provider, nft, m, { site, html, fetchFn } = {}) {
  const t = await trustOf(provider, nft, m.address).catch(() => null);
  if (t) return { ...t, scope: 'all' };
  if (site && await siteMentions(site, html, m.address, fetchFn).catch(() => false)) return { why: 'site', site, scope: 'token' };
  if (provenMarket(m)) return { why: 'buyers', buyers: m.buyers, sellers: m.paidSellers, scope: 'token' };
  return null;
}

const cache = new Map();
export async function findMarkets(provider, nft, { blocks = 200_000, chunk = 5000, deadlineMs = 25_000, maxTx = 40, fetchFn, logs, page } = {}) {
  nft = getAddress(nft);
  const hit = cache.get(nft);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.v;
  if (!logs) {
    const head = await provider.getBlockNumber();
    logs = await getLogsChunked(provider, { address: nft, topics: [TOPIC.TRANSFER] }, Math.max(0, head - blocks), head, chunk, { concurrency: 6, deadlineMs });
  }
  const byTx = new Map();
  for (const l of logs) {
    if (l.topics.length !== 4 || l.topics[1] === TOPIC.ZERO) continue; // bỏ mint và ERC-20
    if (!byTx.has(l.transactionHash)) byTx.set(l.transactionHash, { from: topicToAddress(l.topics[1]), to: topicToAddress(l.topics[2]), tokenId: BigInt(l.topics[3]).toString(), block: l.blockNumber, n: 0 });
    byTx.get(l.transactionHash).n += 1;
  }
  const rows = [...byTx].sort((a, b) => b[1].block - a[1].block).slice(0, maxTx);
  const txs = await mapLimit(rows, 5, async ([hash, t]) => {
    const tx = await provider.getTransaction(hash).catch(() => null);
    return tx?.to ? { hash, ...t, txFrom: tx.from, market: getAddress(tx.to), data: tx.data, value: tx.value ?? 0n } : null;
  });
  const m = new Map();
  for (const t of txs.filter(Boolean)) {
    if (t.market === nft || t.data.length < 10) continue; // chuyển thẳng giữa 2 ví, không qua chợ
    const r = m.get(t.market) ?? { address: t.market, sales: 0, sellers: new Set(), sellSamples: [], buyerSet: new Set(), paidSet: new Set() };
    r.sales += 1;
    r.sellers.add(t.from.toLowerCase());
    // Mua thật: người gửi giao dịch trả BNB và chính họ nhận NFT của người khác.
    if (BigInt(t.value) > 0n && t.txFrom.toLowerCase() === t.to.toLowerCase() && t.from.toLowerCase() !== t.to.toLowerCase()) {
      r.buyerSet.add(t.to.toLowerCase()); r.paidSet.add(t.from.toLowerCase());
    }
    // Người bán tự gửi giao dịch, không kèm BNB, 1 NFT = bán vào lệnh mua (offer) có sẵn trên chợ.
    if (t.txFrom.toLowerCase() === t.from.toLowerCase() && BigInt(t.value) === 0n && t.n === 1) r.sellSamples.push({ hash: t.hash, seller: t.from, tokenId: t.tokenId, data: t.data });
    m.set(t.market, r);
  }
  const out = [...m.values()].sort((a, b) => b.sales - a.sales).slice(0, 4);
  await mapLimit(out, 2, async (r) => {
    r.isContract = (await provider.getCode(r.address).catch(() => '0x')) !== '0x';
    const k = KNOWN[r.address.toLowerCase()];
    const src = k ? null : await Promise.race([verifiedSource(r.address, fetchFn).catch(() => null), new Promise((res) => setTimeout(() => res(null), 8000))]);
    r.name = k?.name ?? src?.name ?? null;
    r.site = k?.site ?? src?.site ?? null;
    r.sellers = r.sellers.size;
    r.buyers = r.buyerSet.size; r.paidSellers = r.paidSet.size;
    delete r.buyerSet; delete r.paidSet;
    if (r.site && /readthedocs|soliditylang|docs\.|github\.com/i.test(r.site)) r.site = null;
    const pg = await Promise.resolve(page).catch(() => null);
    r.trust = k ? null : await trustMarket(provider, nft, r, { site: pg?.site, html: pg?.html, fetchFn }).catch(() => null);
  });
  const v = out.filter((r) => r.isContract);
  if (v.length) cache.set(nft, { at: Date.now(), v }); // không nhớ kết quả rỗng (có thể do RPC lỗi lần này)
  return v;
}

// Chép giao dịch bán mẫu cho NFT của bạn. Chỉ dùng khi số token của mẫu xuất hiện đúng 1 chỗ.
export function adaptSell(sample, { me, tokenId }) {
  const body = sample.data.slice(10).toLowerCase();
  if (body.length % 64) return null;
  const words = body.match(/.{64}/g) ?? [];
  const idW = word(sample.tokenId);
  const hits = words.map((w, i) => (w === idW ? i : -1)).filter((i) => i >= 0);
  if (hits.length !== 1) return null;
  words[hits[0]] = word(tokenId);
  return sample.data.slice(0, 10).toLowerCase() + words.join('').split(pad(sample.seller)).join(pad(me));
}

// Thử lần lượt các giao dịch mẫu, cái nào mô phỏng chạy được cho ví bạn thì dùng.
export async function findInstantSell(provider, market, { me, tokenId }) {
  for (const s of market.sellSamples ?? []) {
    const data = adaptSell(s, { me, tokenId });
    if (!data) continue;
    try {
      await provider.call({ from: me, to: market.address, data, value: 0n });
      return { data, sample: s.hash };
    } catch {}
  }
  return null;
}

// Học từ log của CHỢ (không chỉ log của NFT): đọc giao dịch gần đây gửi vào chợ, chia 2 loại:
// - bán vào lệnh mua: người gửi chuyển NFT của chính họ đi, không gửi kèm BNB  → sellSamples
// - đặt giá bán: NFT không di chuyển, không kèm BNB, dữ liệu gọi hàm có đúng 1 số token của bộ NFT
//   và đúng 1 số tiền (wei) cũng xuất hiện trong log của chợ (= giá vừa đặt)  → listSamples
// Hàm từng chạy "thành công" mà chợ không ghi lệnh rao bán nào (vd. hàm xem danh sách list(offset,count,order)): không dùng lại.
const BAD = 'data/bad-calls.json';
const badKey = (market, data) => `${market}:${String(data).slice(0, 10)}`.toLowerCase();
export function badCalls(path = BAD) { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return {}; } }
export function markBadCall(market, data, why, path = BAD) {
  const b = badCalls(path);
  b[badKey(market, data)] = { why, at: new Date().toISOString() };
  try { mkdirSync('data', { recursive: true }); writeFileSync(path, JSON.stringify(b, null, 2)); } catch {}
}
export const isBadCall = (market, data, b = badCalls()) => Boolean(b[badKey(market, data)]);

const learned = new Map();
// Chợ chỉ bán 1 bộ NFT (vd. chợ Onchain Agents): lệnh đặt giá chỉ có số token + giá, không có địa chỉ bộ NFT.
// Nhận ra khi địa chỉ bộ NFT nằm sẵn trong mã chợ (biến immutable) hoặc 1 hàm đọc của chợ trả về nó.
const COLL_GETTERS = ['nft', 'collection', 'token', 'nftContract', 'nftAddress', 'agents', 'NFT', 'asset'];
export async function singleCollection(provider, market, nft) {
  const code = String(await provider.getCode(market).catch(() => '0x')).toLowerCase();
  if (code.includes(nft.toLowerCase().slice(2))) return true;
  for (const fn of COLL_GETTERS) {
    const r = await tryCall(provider, market, new Interface([`function ${fn}() view returns (address)`]), fn).catch(() => null);
    if (r && r.toLowerCase() === nft.toLowerCase()) return true;
  }
  return false;
}

export async function learnMarket(provider, market, nft, { blocks = 300_000, chunk = 5000, deadlineMs = 30_000, maxTx = 120, maxSupply = 1_000_000n } = {}) {
  const key = `${market}:${nft}`.toLowerCase();
  const hit = learned.get(key);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.v;
  const single = await singleCollection(provider, market, nft).catch(() => false);
  const head = await provider.getBlockNumber();
  const logs = await getLogsChunked(provider, { address: market }, Math.max(0, head - blocks), head, chunk, { concurrency: 6, deadlineMs });
  const hashes = [...new Map(logs.map((l) => [l.transactionHash, l.blockNumber])).entries()].sort((a, b) => b[1] - a[1]).slice(0, maxTx).map(([h]) => h);
  const nftW = pad(nft);
  const v = { sellSamples: [], listSamples: [], single };
  await mapLimit(hashes, 5, async (hash) => {
    const [tx, rc] = await Promise.all([provider.getTransaction(hash).catch(() => null), provider.getTransactionReceipt(hash).catch(() => null)]);
    if (!tx?.to || tx.to.toLowerCase() !== market.toLowerCase() || BigInt(tx.value ?? 0n) !== 0n || !rc || Number(rc.status) !== 1) return;
    const body = tx.data.slice(10).toLowerCase();
    if (!body || body.length % 64) return;
    const words = body.match(/.{64}/g);
    const nftMoves = rc.logs.filter((l) => l.address.toLowerCase() === nft.toLowerCase() && l.topics[0] === TOPIC.TRANSFER && l.topics.length === 4);
    const me = pad(tx.from);
    if (nftMoves.length === 1 && nftMoves[0].topics[1].slice(2).toLowerCase() === me && nftMoves[0].topics[2].slice(2).toLowerCase() !== me) {
      v.sellSamples.push({ hash, seller: tx.from, tokenId: BigInt(nftMoves[0].topics[3]).toString(), data: tx.data });
      return;
    }
    if (nftMoves.length || (!words.includes(nftW) && !single)) return; // đặt giá: NFT chưa di chuyển, gọi hàm có địa chỉ bộ NFT (hoặc chợ chỉ bán bộ này)
    const marketLogs = rc.logs.filter((l) => l.address.toLowerCase() === market.toLowerCase()).map((l) => (l.data + l.topics.join('')).toLowerCase());
    const inLogs = (w) => marketLogs.some((x) => x.includes(w));
    const ids = words.map((w, i) => ({ w, i, n: BigInt('0x' + w) })).filter((x) => x.w !== nftW && x.n < maxSupply && inLogs(x.w));
    const prices = words.map((w, i) => ({ w, i, n: BigInt('0x' + w) })).filter((x) => x.n >= 10n ** 12n && x.n <= 10n ** 24n && inLogs(x.w));
    if (ids.length !== 1 || prices.length !== 1) return; // không chắc vị trí: bỏ
    v.listSamples.push({ hash, seller: tx.from, tokenId: ids[0].n.toString(), idIndex: ids[0].i, priceIndex: prices[0].i, priceWei: prices[0].n.toString(), data: tx.data });
  });
  learned.set(key, { at: Date.now(), v });
  return v;
}

// Dựng lệnh "đặt giá bán" cho NFT của bạn từ 1 mẫu: thay số token, giá, địa chỉ người đặt mẫu.
export function adaptList(s, { me, tokenId, priceWei }) {
  const words = s.data.slice(10).toLowerCase().match(/.{64}/g) ?? [];
  words[s.idIndex] = word(tokenId);
  words[s.priceIndex] = word(priceWei);
  return s.data.slice(0, 10).toLowerCase() + words.join('').split(pad(s.seller)).join(pad(me));
}

// Chưa có mẫu: thử các hàm đặt giá phổ biến, CHỈ hàm có thật trong mã chợ, và phải mô phỏng chạy được.
const LIST_GUESSES = [
  ['list(uint256,uint256)', 'single'], ['listItem(uint256,uint256)', 'single'], ['listAgent(uint256,uint256)', 'single'], ['createListing(uint256,uint256)', 'single'], ['listForSale(uint256,uint256)', 'single'], ['sell(uint256,uint256)', 'single'],
  ['list(address,uint256,uint256)', 'nft'], ['listItem(address,uint256,uint256)', 'nft'], ['createListing(address,uint256,uint256)', 'nft'], ['listToken(address,uint256,uint256)', 'nft'],
];
export async function guessListCall(provider, market, nft, { me, tokenId, priceWei, single }) {
  const code = String(await provider.getCode(market).catch(() => '0x')).toLowerCase();
  for (const [sig, kind] of LIST_GUESSES) {
    if (kind === 'single' && !single) continue;
    const f = new Interface([`function ${sig}`]);
    const fn = f.fragments[0];
    if (!code.includes(fn.selector.slice(2))) continue;
    const data = f.encodeFunctionData(fn, kind === 'single' ? [BigInt(tokenId), BigInt(priceWei)] : [getAddress(nft), BigInt(tokenId), BigInt(priceWei)]);
    if (isBadCall(market, data)) continue;
    try {
      await provider.call({ from: me, to: market, data, value: 0n });
      return { data, sample: null, guessed: sig };
    } catch {}
  }
  return null;
}

export async function findListCall(provider, market, samples, { me, tokenId, priceWei, nft, single } = {}) {
  const bad = badCalls();
  for (const s of samples) {
    const data = adaptList(s, { me, tokenId, priceWei });
    if (isBadCall(market, data, bad)) continue;
    try {
      await provider.call({ from: me, to: market, data, value: 0n });
      return { data, sample: s.hash };
    } catch {}
  }
  return nft ? guessListCall(provider, market, nft, { me, tokenId, priceWei, single }) : null;
}

export const approveMarketData = (market) => nftI.encodeFunctionData('setApprovalForAll', [getAddress(market), true]);
// Quyền cho đúng 1 NFT (chợ chưa chứng minh được cùng chủ với dự án).
export const approveTokenData = (market, tokenId) => nftI.encodeFunctionData('approve', [getAddress(market), BigInt(tokenId)]);
export const revokeMarketData = (market) => nftI.encodeFunctionData('setApprovalForAll', [getAddress(market), false]);
// perToken: chỉ tính quyền riêng cho đúng NFT (getApproved). Nhiều chợ (vd. BN World / Onchain Agents) chỉ hiện và
// chỉ bán được NFT có approve(chợ, số token); quyền cả bộ (setApprovalForAll) không đủ.
export async function marketApproved(provider, nft, owner, market, tokenId, { perToken = false } = {}) {
  const read = async (fn, args) => nftI.decodeFunctionResult(fn, await provider.call({ to: nft, data: nftI.encodeFunctionData(fn, args) }))[0];
  if (!perToken) { try { if (await read('isApprovedForAll', [owner, market])) return true; } catch {} }
  if (tokenId == null) return false;
  try { return (await read('getApproved', [BigInt(tokenId)])).toLowerCase() === market.toLowerCase(); } catch { return false; }
}

// Lệnh rao bán của ví trên chợ, đọc thẳng từ chain (không cần file data/listed.json):
// sự kiện của chợ có topic1 = số token, topic2 = ví người bán, data = [giá wei, hạn (giây)] (vd. Listed của BN World).
export async function onchainListings(provider, market, seller, { blocks = 200_000, chunk = 5000, deadlineMs = 25_000 } = {}) {
  const head = await provider.getBlockNumber();
  const logs = await getLogsChunked(provider, { address: market, topics: [null, null, '0x' + pad(seller)] }, Math.max(0, head - blocks), head, chunk, { deadlineMs });
  const out = new Map();
  for (const l of logs) {
    const words = (l.data ?? '0x').slice(2).match(/.{64}/g) ?? [];
    if (l.topics.length !== 3 || words.length < 1) continue;
    const priceWei = BigInt('0x' + words[0]);
    const expires = words[1] ? Number(BigInt('0x' + words[1])) : 0;
    if (priceWei < 10n ** 12n || priceWei > 10n ** 24n) continue;
    out.set(BigInt(l.topics[1]).toString(), { priceBNB: Number(priceWei) / 1e18, expiresAt: expires > 1e9 && expires < 1e11 ? new Date(expires * 1000).toISOString() : null, txHash: l.transactionHash, market, block: l.blockNumber });
  }
  return out;
}

// Thay đổi số dư Binance mô phỏng (tên trường có thể khác nhau giữa các bản).
export const readChanges = (list = []) => list.map((b) => ({ symbol: b.symbol ?? b.tokenSymbol ?? b.token ?? b.asset ?? '?', amount: String(b.amount ?? b.change ?? b.value ?? b.delta ?? '?') }));

// Tự ước lượng gas trước (Binance báo "Invalid contract-call parameters" khi tự ước lượng không được):
// lỗi ở đây thì báo đúng lý do chợ từ chối, chạy được thì gửi kèm gasLimit cho Binance.
export async function previewMarketCall(cfg, me, to, data, { provider, what = 'giao dịch', log = () => {} } = {}) {
  let gasLimit;
  if (provider) {
    try {
      const est = BigInt(await provider.estimateGas({ from: me, to, data, value: 0n }));
      gasLimit = Math.min(15_000_000, Math.max(21_000, Number(est * 13n / 10n))); // giới hạn baw: 21000–15000000
    } catch (e) {
      const why = (e.shortMessage || e.reason || e.message || '').slice(0, 160);
      log(`[bán] mô phỏng ${what} lỗi: to=${to} hàm=${data.slice(0, 10)} · ${why}`);
      return { ok: false, error: `Hợp đồng từ chối ${what} khi mô phỏng: ${why}` };
    }
  }
  const p = wallet.previewCall({ chainId: cfg.binanceChainId, from: getAddress(me), to: getAddress(to), valueWei: 0n, data, gasLimit });
  if (!p.success) {
    log(`[bán] Binance từ chối ${what}: to=${to} hàm=${data.slice(0, 10)} gas=${gasLimit ?? '?'} · ${p.error?.message ?? JSON.stringify(p.error)}`);
    return { ok: false, error: `Binance từ chối ${what}: ${p.error?.message ?? JSON.stringify(p.error)}` };
  }
  const d = p.data;
  const sim = d.simulationResult ?? {};
  const risks = [
    ...(d.risks?.riskDetails ?? []).map((r) => `[${r.riskType}] ${r.title}: ${r.description}`),
    ...Object.entries(d.risks?.addresses ?? {}).flatMap(([a, v]) => (v.riskDetails ?? []).map((r) => `Địa chỉ ${a}: ${r.title}: ${r.description}`)),
  ];
  return { ok: true, requestId: d.requestId, risks, changes: readChanges(sim.balanceChanges), extraPerms: (sim.allowanceChanges ?? []).length + (sim.authorityChanges ?? []).length, requireConfirmation: d.requireConfirmation };
}
