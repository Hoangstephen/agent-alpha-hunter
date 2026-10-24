// Chợ mua bán riêng của 1 bộ NFT (vd. agentpunk.fun cho Agent Nakamigos), không cần Element.
// 1) Tìm chợ: các giao dịch chuyển NFT gần đây đi qua hợp đồng nào (không phải chính hợp đồng NFT) thì đó là chợ.
// 2) Tin chợ: CHỈ khi chứng minh được chợ do chính đội dự án làm: owner() của chợ = owner() của hợp đồng NFT
//    (khác địa chỉ 0). Hợp đồng drainer cũng chuyển NFT của nhiều người y như chợ, nhưng không thể có cùng chủ
//    với dự án. Chợ không chứng minh được thì bot chỉ hiện link, không cấp quyền, không bán.
// 3) Bán ngay: chép đúng giao dịch người khác đã tự bán vào lệnh mua (offer) trên chợ đó (giống học cách mint),
//    thay số token + địa chỉ ví của họ bằng của bạn. Luôn qua mô phỏng + Binance preview + bạn bấm xác nhận.
import { Interface, getAddress, ZeroAddress } from 'ethers';
import { TOPIC, getLogsChunked, topicToAddress, mapLimit, tryCall } from './chain.js';
import { verifiedSource } from './rules.js';
import { ELEMENT } from './list.js';
import * as wallet from './baw.js';

const KNOWN = { [ELEMENT.EX.toLowerCase()]: { name: 'Element', site: 'https://element.market' } };
const ownI = new Interface(['function owner() view returns (address)']);
const nftI = new Interface(['function setApprovalForAll(address,bool)', 'function isApprovedForAll(address,address) view returns (bool)']);
const pad = (a) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const word = (n) => BigInt(n).toString(16).padStart(64, '0');

// Chợ có cùng chủ (owner) với hợp đồng NFT không. Trả về lý do tin, hoặc null.
export async function trustOf(provider, nft, market) {
  const [a, b] = await Promise.all([tryCall(provider, nft, ownI, 'owner'), tryCall(provider, market, ownI, 'owner')]);
  if (a && b && a !== ZeroAddress && a.toLowerCase() === b.toLowerCase()) return { why: 'same-owner', owner: a };
  return null;
}

const cache = new Map();
export async function findMarkets(provider, nft, { blocks = 200_000, chunk = 5000, deadlineMs = 25_000, maxTx = 40, fetchFn } = {}) {
  nft = getAddress(nft);
  const hit = cache.get(nft);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.v;
  const head = await provider.getBlockNumber();
  const logs = await getLogsChunked(provider, { address: nft, topics: [TOPIC.TRANSFER] }, Math.max(0, head - blocks), head, chunk, { concurrency: 6, deadlineMs });
  const byTx = new Map();
  for (const l of logs) {
    if (l.topics.length !== 4 || l.topics[1] === TOPIC.ZERO) continue; // bỏ mint và ERC-20
    if (!byTx.has(l.transactionHash)) byTx.set(l.transactionHash, { from: topicToAddress(l.topics[1]), tokenId: BigInt(l.topics[3]).toString(), block: l.blockNumber, n: 0 });
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
    const r = m.get(t.market) ?? { address: t.market, sales: 0, sellers: new Set(), sellSamples: [] };
    r.sales += 1;
    r.sellers.add(t.from.toLowerCase());
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
    r.trust = k ? null : await trustOf(provider, nft, r.address).catch(() => null);
  });
  const v = out.filter((r) => r.isContract);
  cache.set(nft, { at: Date.now(), v });
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

export const approveMarketData = (market) => nftI.encodeFunctionData('setApprovalForAll', [getAddress(market), true]);
export async function marketApproved(provider, nft, owner, market) {
  try { return nftI.decodeFunctionResult('isApprovedForAll', await provider.call({ to: nft, data: nftI.encodeFunctionData('isApprovedForAll', [owner, market]) }))[0]; } catch { return false; }
}

// Thay đổi số dư Binance mô phỏng (tên trường có thể khác nhau giữa các bản).
export const readChanges = (list = []) => list.map((b) => ({ symbol: b.symbol ?? b.tokenSymbol ?? b.token ?? b.asset ?? '?', amount: String(b.amount ?? b.change ?? b.value ?? b.delta ?? '?') }));

export function previewMarketCall(cfg, me, to, data) {
  const p = wallet.previewCall({ chainId: cfg.binanceChainId, from: me, to, valueWei: 0n, data });
  if (!p.success) return { ok: false, error: `Binance từ chối: ${p.error?.message ?? JSON.stringify(p.error)}` };
  const d = p.data;
  const sim = d.simulationResult ?? {};
  const risks = [
    ...(d.risks?.riskDetails ?? []).map((r) => `[${r.riskType}] ${r.title}: ${r.description}`),
    ...Object.entries(d.risks?.addresses ?? {}).flatMap(([a, v]) => (v.riskDetails ?? []).map((r) => `Địa chỉ ${a}: ${r.title}: ${r.description}`)),
  ];
  return { ok: true, requestId: d.requestId, risks, changes: readChanges(sim.balanceChanges), extraPerms: (sim.allowanceChanges ?? []).length + (sim.authorityChanges ?? []).length, requireConfirmation: d.requireConfirmation };
}
