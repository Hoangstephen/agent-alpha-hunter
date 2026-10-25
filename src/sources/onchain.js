// Nguồn 1: phát hiện NFT đang được mint dồn dập trên BSC (ERC-721 / ERC-1155 mint từ address(0)),
// rồi đo tỉ lệ người mint là ví có Agent ID (.ai) — dấu hiệu của "agent-only mint".
import { getAddress } from 'ethers';
import { TOPIC, getLogsChunked, topicToAddress, tryCall, erc721, mapLimit } from '../chain.js';
import { ADDR } from '../config.js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const REGISTRY_HEX = ADDR.AGENT_ID_REGISTRY.slice(2).toLowerCase();

// Hàm thuần, tách riêng để test: gom log mint theo hợp đồng.
export function aggregateMints(logs) {
  const by = new Map();
  const seen = new Set();
  for (const log of logs) {
    const key = `${log.transactionHash}:${log.index ?? log.logIndex}`;
    if (seen.has(key)) continue; // RPC có thể trả trùng log giữa các đoạn quét
    seen.add(key);
    let minter;
    let standard;
    if (log.topics[0] === TOPIC.TRANSFER && log.topics.length === 4 && log.topics[1] === TOPIC.ZERO) {
      minter = topicToAddress(log.topics[2]);
      standard = 'ERC721';
    } else if (log.topics[0] === TOPIC.TRANSFER_SINGLE && log.topics.length === 4 && log.topics[2] === TOPIC.ZERO) {
      minter = topicToAddress(log.topics[3]);
      standard = 'ERC1155';
    } else continue; // ERC-20 Transfer chỉ có 3 topic -> bỏ qua

    const addr = getAddress(log.address);
    const row = by.get(addr) ?? { address: addr, standard, mints: 0, minters: new Set(), firstBlock: log.blockNumber, lastBlock: log.blockNumber, txs: new Map() };
    row.mints += 1;
    row.minters.add(minter);
    if (standard === 'ERC721') row.lastId = BigInt(log.topics[3]).toString(); // số token vừa mint, để đọc metadata (tìm web dự án)
    const t = row.txs.get(log.transactionHash) ?? { hash: log.transactionHash, n: 0, minter };
    t.n += 1;
    row.txs.set(log.transactionHash, t);
    row.firstBlock = Math.min(row.firstBlock, log.blockNumber);
    row.lastBlock = Math.max(row.lastBlock, log.blockNumber);
    by.set(addr, row);
  }
  return [...by.values()].map((r) => ({ ...r, uniqueMinters: r.minters.size, minters: [...r.minters], txs: [...r.txs.values()] }));
}

export async function agentRatio(provider, minters, sample) {
  const pick = minters.slice(0, sample);
  if (!pick.length) return 0;
  const bals = await Promise.all(pick.map((m) => tryCall(provider, ADDR.AGENT_ID_REGISTRY, erc721, 'balanceOf', [m])));
  return bals.filter((b) => b && b > 0n).length / pick.length;
}

export async function scanOnchainMints(provider, cfg, log = console.log) {
  const head = await provider.getBlockNumber();
  const from = head - cfg.scan.blocks;
  log(`[onchain] quét mint NFT block ${from} → ${head}`);
  const [l721, l1155] = await Promise.all([
    getLogsChunked(provider, { topics: [TOPIC.TRANSFER, TOPIC.ZERO] }, from, head, cfg.scan.chunk),
    getLogsChunked(provider, { topics: [TOPIC.TRANSFER_SINGLE, null, TOPIC.ZERO] }, from, head, cfg.scan.chunk),
  ]);
  // Bỏ chính sổ Agent ID (đăng ký tên .ai không phải đợt mint NFT).
  const all = aggregateMints([...l721, ...l1155]).filter((r) => r.address.toLowerCase() !== ADDR.AGENT_ID_REGISTRY.toLowerCase());
  const rows = all
    .filter((r) => r.mints >= cfg.scan.minMints && r.uniqueMinters >= cfg.scan.minUniqueMinters)
    .sort((a, b) => b.uniqueMinters - a.uniqueMinters)
    .slice(0, cfg.scan.top);

  // Hidden gem: NFT chỉ dành cho Agent ID thường mint chậm, không đủ ngưỡng "hot".
  // Xét thêm các hợp đồng ít người mint: có gọi tới sổ Agent ID trong bytecode, hoặc phần lớn người mint có Agent ID.
  const picked = new Set(rows.map((r) => r.address));
  const gemCands = all.filter((r) => !picked.has(r.address) && r.uniqueMinters >= (cfg.scan.gemMinMinters ?? 2))
    .sort((a, b) => b.uniqueMinters - a.uniqueMinters).slice(0, cfg.scan.gemCandidates ?? 25);
  const gems = (await mapLimit(gemCands, 5, async (r) => {
    const code = await provider.getCode(r.address).catch(() => '0x');
    r.usesAgentId = code.toLowerCase().includes(REGISTRY_HEX);
    r.agentRatio = await agentRatio(provider, r.minters, 8);
    return r.usesAgentId || r.agentRatio >= 0.6 ? r : null;
  })).filter(Boolean);
  for (const g of gems) g.gem = true;

  await mapLimit(rows, 5, async (r) => {
    r.agentRatio = await agentRatio(provider, r.minters, cfg.scan.sampleMintersForAgentCheck);
  });
  const out = [...rows, ...gems];
  await mapLimit(out, 5, async (r) => {
    [r.name, r.symbol] = await Promise.all([tryCall(provider, r.address, erc721, 'name'), tryCall(provider, r.address, erc721, 'symbol')]);
  });
  if (gems.length) log(`[onchain] 💎 ${gems.length} hidden gem (agent-only, mint chậm): ${gems.map((g) => g.name ?? g.address.slice(0, 10)).join(', ')}`);
  rememberGems(gems, cfg);
  return out.map((r) => ({
    source: 'onchain',
    kind: 'nft',
    address: r.address,
    standard: r.standard,
    name: r.name,
    symbol: r.symbol,
    mints: r.mints,
    uniqueMinters: r.uniqueMinters,
    agentRatio: r.agentRatio,
    gem: Boolean(r.gem),
    lastId: r.lastId ?? null,
    mintTxs: r.txs.slice(-10), // giao dịch mint gần nhất, để đọc giá người khác đang trả
    blocks: [r.firstBlock, r.lastBlock],
  }));
}

// Nhớ hidden gem 24 giờ (data/gems.json): dự án mint chậm vẫn được theo dõi dù lượt quét sau không thấy ai mint.
const GEMS = 'data/gems.json';
const DAY = 24 * 3600_000;
function rememberGems(gems, cfg) {
  if (cfg.scan.rememberGems === false) return;
  let saved = {};
  try { saved = JSON.parse(readFileSync(GEMS, 'utf8')); } catch {}
  for (const g of gems) saved[g.address] = { name: g.name ?? null, lastSeen: Date.now(), firstSeen: saved[g.address]?.firstSeen ?? Date.now() };
  for (const [a, v] of Object.entries(saved)) if (Date.now() - v.lastSeen > DAY) delete saved[a];
  try { mkdirSync('data', { recursive: true }); writeFileSync(GEMS, JSON.stringify(saved, null, 2)); } catch {}
}
export function savedGems() {
  try { return Object.entries(JSON.parse(readFileSync(GEMS, 'utf8'))).filter(([, v]) => Date.now() - v.lastSeen <= DAY).map(([address, v]) => ({ address, ...v })); } catch { return []; }
}
