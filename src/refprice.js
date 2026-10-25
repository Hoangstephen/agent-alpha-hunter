// Giá tham khảo cho 1 bộ NFT, bot tự tìm (chỉ ĐỌC, không cấp quyền, không ký gì):
// 1) Chợ riêng của bộ NFT: các lệnh rao bán đang treo, đọc thẳng từ sự kiện của chợ trên chain.
//    Chỉ tính lệnh còn hạn, người rao vẫn giữ NFT và chợ có quyền chuyển NFT đó (lệnh "ma" thì bỏ).
// 2) Web dự án + web chợ: các con số kiểu "Floor 0.005 BNB", "Price: 0.01 BNB" ghi trên trang.
//    Web có thể ghi sai/cũ nên chỉ để bạn tham khảo, không dùng để tự đặt giá.
import { Interface } from 'ethers';
import { getLogsChunked, multiRead } from './chain.js';
import { listingEvents, singleCollection } from './markets.js';
import { fetchText } from './rules.js';

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
export async function refPrices(provider, nft, { markets = [], page, wallet, fetchFn = fetch, deadlineMs = 25_000 } = {}) {
  const ref = { asks: [], web: [] };
  await Promise.all([
    ...markets.filter((m) => m.isContract).slice(0, 2).map(async (m) => {
      const a = await marketAsks(provider, m.address, nft, { exclude: wallet, deadlineMs }).catch(() => null);
      if (a?.count) ref.asks.push({ market: m.address, site: m.site ?? null, ...a });
    }),
    (async () => {
      const pg = await Promise.resolve(page).catch(() => null);
      const sites = [[pg?.site, pg?.html], ...markets.filter((m) => m.site).slice(0, 2).map((m) => [m.site, null])];
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
