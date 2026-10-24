// Tìm chợ mua bán riêng của 1 bộ NFT (vd. agentpunk.fun cho Agent Nakamigos), không cần Element.
// Cách tìm: các giao dịch chuyển NFT gần đây đi qua hợp đồng nào (không phải chính hợp đồng NFT) thì đó là chợ.
// Bot CHỈ tìm và hiện chợ + link web của chợ. Bot KHÔNG tự cấp quyền chuyển NFT cho chợ tự tìm được:
// hợp đồng drainer cũng "chuyển NFT của nhiều người" y như chợ, nên không thể phân biệt an toàn bằng dữ liệu chain.
import { getAddress } from 'ethers';
import { TOPIC, getLogsChunked, topicToAddress, mapLimit } from './chain.js';
import { verifiedSource } from './rules.js';
import { ELEMENT } from './list.js';

const KNOWN = { [ELEMENT.EX.toLowerCase()]: { name: 'Element', site: 'https://element.market' } };

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
    if (!byTx.has(l.transactionHash)) byTx.set(l.transactionHash, { from: topicToAddress(l.topics[1]), block: l.blockNumber });
  }
  const rows = [...byTx].sort((a, b) => b[1].block - a[1].block).slice(0, maxTx);
  const txs = await mapLimit(rows, 5, async ([hash, t]) => {
    const tx = await provider.getTransaction(hash).catch(() => null);
    return tx?.to ? { ...t, market: getAddress(tx.to), data: tx.data } : null;
  });
  const m = new Map();
  for (const t of txs.filter(Boolean)) {
    if (t.market === nft || t.data.length < 10) continue; // chuyển thẳng giữa 2 ví, không qua chợ
    const r = m.get(t.market) ?? { address: t.market, sales: 0, sellers: new Set() };
    r.sales += 1;
    r.sellers.add(t.from.toLowerCase());
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
  });
  const v = out.filter((r) => r.isContract);
  cache.set(nft, { at: Date.now(), v });
  return v;
}
