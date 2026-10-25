// Giá tham khảo cho 1 bộ NFT, bot tự tìm (chỉ ĐỌC, không cấp quyền, không ký gì):
// 1) Chợ riêng của bộ NFT: các lệnh rao bán đang treo, đọc thẳng từ sự kiện của chợ trên chain.
//    Chỉ tính lệnh còn hạn, người rao vẫn giữ NFT và chợ có quyền chuyển NFT đó (lệnh "ma" thì bỏ).
// 2) Web dự án + web chợ: các con số kiểu "Floor 0.005 BNB", "Price: 0.01 BNB" ghi trên trang.
//    Web có thể ghi sai/cũ nên chỉ để bạn tham khảo, không dùng để tự đặt giá.
// NFT không có web, hoặc web không có chợ, thì bot bỏ qua (không định giá, không bán).
import { Interface, id, getAddress } from 'ethers';
import { getLogsChunked, multiRead } from './chain.js';
import { listingEvents, singleCollection } from './markets.js';
import { fetchText, siteTexts } from './rules.js';

const nftI = new Interface(['function ownerOf(uint256) view returns (address)', 'function getApproved(uint256) view returns (address)', 'function isApprovedForAll(address,address) view returns (bool)']);
const cache = new Map();
const TTL = 5 * 60_000;

// Lệnh rao bán đang treo của mọi người trên 1 chợ cho bộ NFT này. Trả về giá rẻ nhất (floor) + vài lệnh rẻ nhất.
export async function marketAsks(provider, market, nft, { blocks = 200_000, chunk = 5000, deadlineMs = 25_000, now = Date.now(), exclude } = {}) {
  const key = `${market}:${nft}`.toLowerCase();
  const hit = cache.get(key);
  let asks = hit && now - hit.at < TTL ? hit.v : null;
  if (!asks) {
    // Chợ bán nhiều bộ NFT thì sự kiện không cho biết NFT của bộ nào: không đoán.
    if (!(await singleCollection(provider, market, nft).catch(() => false))) return null;
    const head = await provider.getBlockNumber();
    const logs = await getLogsChunked(provider, { address: market }, Math.max(0, head - blocks), head, chunk, { concurrency: 6, deadlineMs });
    const all = [...listingEvents(logs, market)].map(([tokenId, l]) => ({ tokenId, ...l }))
      .filter((a) => !a.expiresAt || Date.parse(a.expiresAt) > now)
      .sort((a, b) => a.priceBNB - b.priceBNB).slice(0, 40);
    // Lệnh còn hiệu lực: người rao vẫn là chủ NFT và chợ có quyền chuyển NFT đó.
    const reads = all.flatMap((a) => [
      { target: nft, iface: nftI, fn: 'ownerOf', args: [BigInt(a.tokenId)] },
      { target: nft, iface: nftI, fn: 'getApproved', args: [BigInt(a.tokenId)] },
      { target: nft, iface: nftI, fn: 'isApprovedForAll', args: [a.seller, market] },
    ]);
    const r = await multiRead(provider, reads);
    asks = all.filter((a, i) => {
      const [owner, appr, all4] = r.slice(i * 3, i * 3 + 3);
      return owner && owner.toLowerCase() === a.seller.toLowerCase() && (appr?.toLowerCase() === market.toLowerCase() || all4 === true);
    });
    if (!logs.incomplete) cache.set(key, { at: now, v: asks });
  }
  const others = exclude ? asks.filter((a) => a.seller.toLowerCase() !== exclude.toLowerCase()) : asks;
  if (!others.length) return { count: 0, floorBNB: null, asks: [] };
  return { count: others.length, floorBNB: others[0].priceBNB, asks: others.slice(0, 5).map(({ tokenId, priceBNB, seller, expiresAt }) => ({ tokenId, priceBNB, seller, expiresAt })) };
}

// Số tiền BNB có nhãn giá trên trang web. Nhãn: floor / price / giá / mint / 地板 / 价格 …
const LABEL = /(floor(?:\s*price)?|lowest|price|giá(?:\s*sàn)?|sàn|mint(?:\s*price)?|地板价?|价格|售价)/i;
const strip = (h = '') => String(h).replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/\s+/g, ' ');
const kind = (label) => /floor|lowest|sàn|地板/i.test(label) ? 'floor' : /mint/i.test(label) ? 'mint' : 'price';

export function webPrices(html = '', { max = 6 } = {}) {
  const text = strip(html);
  const out = [];
  const seen = new Set();
  const add = (label, n, snippet) => {
    if (!(n > 0 && n < 1000)) return;
    const k = `${kind(label)}:${n}`;
    if (seen.has(k) || out.length >= max) return;
    seen.add(k);
    out.push({ kind: kind(label), priceBNB: n, snippet: snippet.trim().slice(0, 90) });
  };
  // "Floor Price 0.0042 BNB", "Giá: 0,01 BNB", "Mint price — 0.005 BNB"
  for (const m of text.matchAll(new RegExp(`${LABEL.source}[^\\d]{0,25}?(\\d+(?:[.,]\\d+)?)\\s*(?:W?BNB)\\b`, 'gi'))) add(m[1], Number(m[2].replace(',', '.')), m[0]);
  // Dữ liệu JSON nhúng trong trang (vd. __NEXT_DATA__): "floorPrice":"0.004" (số lớn = wei).
  for (const m of String(html).matchAll(/"(floor_?price|floor|lowestPrice|minPrice)"\s*:\s*"?(\d+(?:\.\d+)?)"?/gi)) {
    const v = Number(m[2]);
    add('floor', v > 1e9 ? v / 1e18 : v, m[0]);
  }
  return out;
}

// Gom giá tham khảo cho 1 bộ NFT: lệnh rao trên chợ riêng + giá ghi trên web dự án / web chợ.
export async function refPrices(provider, nft, { markets = [], page, wallet, market, fetchFn = fetch, deadlineMs = 25_000 } = {}) {
  const ref = { asks: [], web: [] };
  if (market?.contract && !markets.some((m) => m.address.toLowerCase() === market.contract.toLowerCase())) markets = [{ address: market.contract, isContract: true, site: market.url }, ...markets];
  await Promise.all([
    ...markets.filter((m) => m.isContract).slice(0, 2).map(async (m) => {
      const a = await marketAsks(provider, m.address, nft, { exclude: wallet, deadlineMs }).catch(() => null);
      if (a?.count) ref.asks.push({ market: m.address, site: m.site ?? null, ...a });
    }),
    (async () => {
      const pg = await Promise.resolve(page).catch(() => null);
      const sites = [[market?.url, null], [pg?.site, pg?.html], ...markets.filter((m) => m.site).slice(0, 2).map((m) => [m.site, null])];
      const done = new Set();
      for (const [site, html0] of sites) {
        if (!site || done.has(site)) continue;
        done.add(site);
        const html = html0 || await fetchText(site, fetchFn).catch(() => '');
        const prices = webPrices(html);
        if (prices.length) ref.web.push({ site, prices });
      }
    })(),
  ]);
  ref.asks.sort((a, b) => a.floorBNB - b.floorBNB);
  ref.floorBNB = ref.asks[0]?.floorBNB ?? null;
  return ref;
}

// Hàm của hợp đồng chợ (mua / rao / gỡ). Hợp đồng mint riêng cũng có thể chứa địa chỉ NFT nhưng không có các hàm này.
const MARKET_FNS = ['buy(uint256)', 'purchase(uint256)', 'buyItem(uint256)', 'buyNFT(uint256)', 'buyToken(uint256)', 'list(uint256,uint256)', 'list(uint256,uint256,uint256)',
  'listItem(uint256,uint256)', 'listNFT(uint256,uint256)', 'createListing(uint256,uint256)', 'cancelListing(uint256)', 'cancel(uint256)', 'delist(uint256)', 'unlist(uint256)',
  'buy(address,uint256)', 'buyItem(address,uint256)', 'listItem(address,uint256,uint256)', 'createListing(address,uint256,uint256)', 'cancelListing(address,uint256)'];
const MARKET_SELS = MARKET_FNS.map((f) => '63' + id(f).slice(2, 10)); // PUSH4 <selector> trong bytecode
export const looksLikeMarket = (code = '', nft = '') => {
  const c = String(code).toLowerCase();
  return c.length > 2 && c.includes(nft.toLowerCase().slice(2)) && MARKET_SELS.some((s) => c.includes(s));
};

const MARKET_WORD = /(^|[^a-z])(market(place)?|trade|trading|listings?|shop)([^a-z]|$)|chợ|mua bán|市场|交易/i;
const ROUTE = /["'`](\/(?:market(?:place)?|trade|trading|listings?|shop)(?:\/[\w-]*)?)["'`?#]/gi;
const OUTSIDE = /element\.market|opensea|okx\.com|magiceden|x\.com|twitter|discord|t\.me|telegram|github|gitbook|medium\.com|youtube|bscscan|pancakeswap/i;
const root = (h) => h.split('.').slice(-2).join('.');

// Web dự án có chợ mua bán NFT không. Có khi web ghi địa chỉ hợp đồng chợ của bộ NFT này
// (trong trang hoặc file JS của trang), hoặc có mục / link Market, Marketplace, Trade… cùng tên miền.
export async function siteMarket(provider, nft, page, { markets = [], fetchFn = fetch } = {}) {
  if (!page?.site) return { ok: false, why: 'no-site', site: null };
  const site = page.site;
  const texts = await siteTexts(site, page.html, fetchFn).catch(() => [page.html ?? '']);
  const low = texts.join('\n').toLowerCase();
  let contract = markets.find((m) => m.isContract !== false && low.includes(m.address.toLowerCase().slice(2)))?.address ?? null;
  if (!contract) {
    const cands = [...new Set((low.match(/0x[0-9a-f]{40}/g) ?? []))].filter((a) => a !== nft.toLowerCase()).slice(0, 12);
    for (const a of cands) {
      const code = await provider.getCode(a).catch(() => '0x');
      if (looksLikeMarket(code, nft)) { contract = getAddress(a); break; }
    }
  }
  let base;
  try { base = new URL(site); } catch { return { ok: Boolean(contract), why: contract ? null : 'no-market', site, contract, url: contract ? site : null, via: contract ? 'contract' : null }; }
  let url = null;
  for (const m of String(page.html ?? texts[0] ?? '').matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi)) {
    let u;
    try { u = new URL(m[1], base); } catch { continue; }
    if (!/^https?:$/.test(u.protocol) || OUTSIDE.test(u.hostname) || root(u.hostname) !== root(base.hostname)) continue;
    const text = m[2].replace(/<[^>]+>/g, ' ');
    if (MARKET_WORD.test(u.pathname) || MARKET_WORD.test(u.hostname.split('.')[0]) || MARKET_WORD.test(text)) { url = u.href; break; }
  }
  if (!url) for (const t of texts.slice(1)) { const m = ROUTE.exec(t); ROUTE.lastIndex = 0; if (m) { url = new URL(m[1], base).href; break; } }
  const ok = Boolean(contract || url);
  return { ok, why: ok ? null : 'no-market', site, contract, url: url ?? (contract ? site : null), via: contract ? 'contract' : url ? 'link' : null };
}
