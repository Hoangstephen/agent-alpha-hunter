// Gom 3 nguồn tín hiệu thành một danh sách NFT hot, kèm giá / giới hạn / điểm an toàn.
import { formatEther, formatUnits } from 'ethers';
import { scanOnchainMints, savedGems } from './sources/onchain.js';
import { scanGang } from './sources/gang.js';
import { scanX } from './sources/x.js';
import { inspectContract } from './risk.js';
import { mapLimit } from './chain.js';
import { maxQty, unitCostBNB } from './mint.js';
import { mintStats, recentSales } from './sell.js';
import { rulesFor, projectPage, webRules } from './rules.js';

// Điểm hot: nhiều ví mint khác nhau + tỉ lệ ví Agent ID cao + được nhắc trên X.
export function alphaScore(row) {
  const minters = Math.min(row.uniqueMinters ?? 0, 200) / 2;
  const agent = (row.agentRatio ?? 0) * 100;
  const x = Math.min((row.xMentions ?? 0) * 10, 50);
  const gem = row.gem ? 25 : 0; // NFT chỉ dành cho Agent ID: ưu tiên dù ít người mint
  return Math.min(100, Math.round(minters * 0.4 + agent * 0.4 + x * 0.4 + gem));
}

const s = (v) => (v == null ? null : v.toString());

export function summarize(info, cfg, { bnbUsdt } = {}) {
  const q = maxQty(info, cfg, { bnbUsdt });
  const priceBNB = info.price ? (info.payToken ? unitCostBNB(info, bnbUsdt) : Number(formatEther(info.price.wei))) : null;
  const walletPriceBNB = info.walletPrice != null ? Number(formatEther(info.walletPrice)) : null;
  const usd = (b) => (bnbUsdt && b ? ` (≈ ${(b * bnbUsdt).toFixed(2)} USDT)` : '');
  const bnbText = (b) => (b == null ? null : b === 0 ? 'miễn phí' : `${b} BNB${usd(b)}`);
  const rules = rulesFor(info, { priceText: bnbText(priceBNB), walletPriceText: bnbText(walletPriceBNB) });
  return {
    rules,
    name: info.name,
    standard: info.standard,
    risk: info.score,
    riskFlags: info.flags,
    mintFn: info.mintCandidates?.[0] ?? null,
    // Giá đọc từ hợp đồng, quy ra BNB (kể cả khi trả bằng USDT).
    priceBNB,
    payToken: info.payToken?.symbol ?? 'BNB',
    priceToken: info.payToken && info.price ? Number(formatUnits(info.price.wei, info.payToken.decimals)) : null,
    walletMinted: s(info.walletMinted),
    maxPerWallet: s(info.maxPerWallet),
    perWalletFrom: info.perWalletFrom ?? null,
    maxPerTx: s(info.maxPerTx),
    minted: s(info.totalSupply),
    mintedGetter: info.mintedGetter ?? null,
    maxSupply: s(info.maxSupply),
    paused: info.paused,
    mintTakesQty: /uint\d*\)$/.test(info.mintCandidates?.[0] ?? ''),
    walletPriceBNB,
    startAt: info.startAt,
    mintOpen: info.mintOpen,
    hasAgentId: info.hasAgentId,
    agentMint: info.agentMint || false,
    agent: info.agent ? { name: info.agent.name, tokenId: info.agent.tokenId, ok: info.agent.ok } : null,
    maxQty: q.max,
    maxQtyWhy: q.limitedBy,
  };
}

// Hai hợp đồng cùng tên: cái ít người mint hơn rất có thể là bản giả nhái dự án thật.
const minted = (n) => Number(n.minted ?? n.mints ?? 0) || 0;
export function markLookalikes(list) {
  const key = (n) => String(n.name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const groups = new Map();
  for (const n of list) if (key(n)) groups.set(key(n), [...(groups.get(key(n)) ?? []), n]);
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const main = [...g].sort((a, b) => minted(b) - minted(a))[0];
    for (const n of g) {
      n.lookalike = n === main ? null : { of: main.address, minted: minted(main) };
      n.twins = g.filter((x) => x !== n).map((x) => x.address);
    }
  }
  return list;
}

// Lãi/lỗ ước tính mỗi NFT nếu mint rồi bán ngay ở giá trung vị gần đây (chưa trừ phí sàn).
export function profitBNB(n) {
  const cost = (n.paid?.priceBNB ?? n.priceBNB ?? 0) + (n.paid?.gasBNB ?? 0);
  return n.sales?.medianBNB ? n.sales.medianBNB - cost : null;
}

export async function scanAll(provider, cfg, log = console.log, { walletAddr, bnbUsdt, onProgress = () => {} } = {}) {
  const t0 = Date.now();
  const report = (stage, extra = {}) => onProgress({ stage, elapsedMs: Date.now() - t0, ...extra });
  report('Bước 1/2: đọc giao dịch mint, gang.fun, X');
  const [nfts, tokens, xs] = await Promise.all([
    scanOnchainMints(provider, cfg, log).catch((e) => (log(`[onchain] lỗi: ${e.shortMessage || e.message}`), [])),
    scanGang(provider, cfg, log).catch((e) => (log(`[gang.fun] lỗi: ${e.shortMessage || e.message}`), [])),
    scanX(cfg, log).catch((e) => (log(`[x] lỗi: ${e.message}`), [])),
  ]);
  log(`[scan] bước 1 xong sau ${((Date.now() - t0) / 1000).toFixed(1)}s: ${nfts.length} NFT đang mint`);

  // Hidden gem đã thấy trong 24 giờ qua nhưng lượt này không ai mint: vẫn theo dõi.
  for (const g of savedGems()) if (!nfts.some((n) => n.address === g.address)) nfts.push({ source: 'gem-watch', address: g.address, name: g.name, mints: 0, uniqueMinters: 0, agentRatio: 1, gem: true });
  const xBy = new Map(xs.map((x) => [x.address, x]));
  // Địa chỉ được nhắc trên X nhưng chưa thấy mint trong cửa sổ quét: vẫn đưa vào danh sách.
  for (const x of xs) if (!nfts.some((n) => n.address === x.address)) nfts.push({ source: 'x', address: x.address, mints: 0, uniqueMinters: 0, agentRatio: 0 });
  for (const n of nfts) {
    n.xMentions = xBy.get(n.address)?.mentions ?? 0;
    n.xLinks = xBy.get(n.address)?.examples ?? [];
    n.hot = alphaScore(n);
  }
  nfts.sort((a, b) => b.hot - a.hot);

  const top = nfts.slice(0, 12);
  // Bỏ những địa chỉ không phải NFT (ví thường, token ERC-20 được nhắc trên X...).
  const visible = () => markLookalikes(top.filter((n) => (n.standard && n.standard !== '?') || n.source === 'onchain' || n.source === 'gem-watch').map(({ mintTxs, ...rest }) => rest));
  let done = 0;
  const partial = () => ({ nfts: visible(), tokens, partial: true });
  report('Bước 2/2: kiểm tra giá, giới hạn, rủi ro', { done, total: top.length, result: partial() });

  // Mỗi NFT hiện lên giao diện ngay khi kiểm tra xong.
  await mapLimit(top, 4, async (n, i) => {
    // Link X của dự án (từ metadata / trang web), chạy song song, tối đa 8 giây.
    const page = Promise.race([projectPage(provider, n.address).catch(() => null), new Promise((r) => setTimeout(() => r(null), 8000))]);
    const info = await inspectContract(provider, n.address, cfg, walletAddr).catch(() => null);
    const pg = await page;
    n.projectX = pg?.x ?? null;
    if (info && info.maxPerWallet == null && pg?.perWallet) Object.assign(info, { maxPerWallet: BigInt(pg.perWallet), perWalletFrom: 'site' });
    // Luật từ web dự án / mã nguồn, tải sẵn cho các thẻ đầu (không phải bấm mở mới thấy).
    const web = i < 8 && info ? await Promise.race([webRules(provider, n.address, info).catch(() => null), new Promise((r) => setTimeout(() => r(null), 12_000))]) : null;
    if (info) Object.assign(n, summarize(info, cfg, { bnbUsdt }), { name: n.name ?? info.name });
    if (web && n.rules) {
      if (!n.rules.rules?.length && web.rules?.length) Object.assign(n.rules, { rules: web.rules, site: n.rules.site ?? web.site, fromSource: web.fromSource });
      if (web.description) n.rules.description ??= web.description;
      if (web.checks?.length) n.rules.checks = [...new Set([...(n.rules.checks ?? []), ...web.checks])];
    }
    // Giá người khác đang trả + giá đang bán được (top 6 để đỡ tốn RPC).
    if (i < 6) {
      const [paid, sales] = await Promise.all([
        n.mintTxs?.length ? mintStats(provider, n.mintTxs, { bnbUsdt }).catch(() => null) : null,
        recentSales(provider, n.address, { chunk: cfg.scan.chunkByAddress ?? 2000, bnbUsdt, maxTx: 15 }).catch(() => ({ count: 0 })),
      ]);
      Object.assign(n, { paid, sales });
      n.profitBNB = profitBNB(n);
    }
    done += 1;
    report('Bước 2/2: kiểm tra giá, giới hạn, rủi ro', { done, total: top.length, result: partial() });
  });
  const durationMs = Date.now() - t0;
  log(`[scan] xong sau ${(durationMs / 1000).toFixed(1)}s`);
  return { nfts: visible(), tokens, scannedAt: new Date().toISOString(), durationMs };
}
