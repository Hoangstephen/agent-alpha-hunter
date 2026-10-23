// Luật mint của MỌI NFT, bằng tiếng Việt, từ 3 nguồn:
// 1. Số liệu đọc trực tiếp từ hợp đồng (tổng cung, giới hạn ví, giá, giờ mở...).
// 2. Thông báo lỗi trong bytecode / tên lỗi trong ABI: đây là các điều kiện hợp đồng THỰC SỰ kiểm tra.
// 3. Trang web của dự án (lấy từ metadata NFT): mục Rules / How to mint, dịch tự động sang tiếng Việt.
// Nguồn 1 và 2 đáng tin hơn nguồn 3 (trang web dự án tự viết, có thể sai hoặc lừa).
import { Interface } from 'ethers';
import { tryCall } from './chain.js';
import { KNOWN } from './projects.js';
import { rememberSite } from './sitefacts.js';

// Thông báo lỗi phổ biến → luật tiếng Việt. Thứ tự quan trọng: mẫu cụ thể đứng trước.
const PATTERNS = [
  [/agent ?id|\.ai\b|not (an? )?agent|agent (only|required)|no agent/i, 'Ví mint phải có Binance Agent ID (.ai).'],
  [/whitelist|allow ?list|not eligible|merkle|proof|not whitelisted|presale/i, 'Có danh sách ưu tiên (whitelist): chỉ ví trong danh sách được mint ở vòng đó.'],
  [/signature|signer|invalid sig|ecdsa: invalid/i, 'Cần chữ ký từ máy chủ dự án: thường phải mint qua trang web dự án.'],
  [/per ?(wallet|address|user|account)|wallet (limit|cap|max)|max(imum)? (mint(s|ed)? )?(per|for) (wallet|address)|already (minted|claimed)|exceeds? (wallet|your) (limit|allowance)|mint limit|limit reached/i, 'Giới hạn số NFT mỗi ví (chuyển NFT đi không làm mới lượt).'],
  [/per ?(tx|transaction)|batch|max(imum)? (mint )?amount/i, 'Giới hạn số NFT mỗi giao dịch.'],
  [/sold ?out|max(imum)? supply|exceeds? (max )?supply|supply (exceeded|reached|limit)|minted out|no more/i, 'Có trần tổng cung: mint hết là đóng.'],
  [/not (yet )?(started|active|open|live|begun)|(mint|sale) (is )?(closed|not|inactive|ended|over)|too early|has ended|not enabled|mint off/i, 'Chỉ mint được trong thời gian dự án mở mint.'],
  [/insufficient|wrong (value|price|amount)|incorrect (value|payment|eth|bnb|price|amount)|not enough|invalid (value|payment|price)|underpaid|msg\.value|pay(ment)? (required|failed)/i, 'Phải gửi đúng số tiền theo giá mint.'],
  [/contract|eoa|tx\.origin|no bots?|bot not allowed|smart wallet/i, 'Không cho hợp đồng/bot gọi trực tiếp, chỉ ví thường.'],
  [/cooldown|too soon|wait|once per/i, 'Có thời gian chờ giữa các lần mint.'],
  [/paused|pausable/i, 'Chủ hợp đồng có thể tạm dừng mint bất cứ lúc nào.'],
  [/refund|transfer failed|withdraw/i, null], // nội bộ, không phải luật cho người mint
];
// Thông báo của thư viện chuẩn, không nói gì về luật dự án.
const BOILERPLATE = /[<>{}=]|base64|svg|xmlns|^\s*data:|^(ERC721|ERC1155|ERC20|Ownable|Address|Strings|SafeMath|ReentrancyGuard|Initializable|ERC721A|Math|Context|AccessControl|Counters|SafeERC20|UUPS|ERC1967|Proxy|EIP712|ECDSA)\b|^(ipfs|https?):|\.json$|^data:|^[0-9a-f]{12,}$/i;

const words = (camel) => camel.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ');

export function contractRules(info) {
  const out = new Set();
  const raw = [];
  for (const s of [...(info.revertStrings ?? []), ...(info.errorNames ?? []).map(words)]) {
    if (BOILERPLATE.test(s)) continue;
    const hit = PATTERNS.find(([re]) => re.test(s));
    if (hit) { if (hit[1]) out.add(hit[1]); } else if (s.length <= 80 && /\s/.test(s)) raw.push(s);
  }
  if (info.usesAgentId) out.add('Ví mint phải có Binance Agent ID (.ai) (hợp đồng có gọi tới sổ Agent ID).');
  return { rules: [...out], untranslated: raw.slice(0, 8) };
}

const fmt = (v) => (v == null ? null : Number(v).toLocaleString('vi-VN'));

// Luật nhanh (không cần mạng ngoài): số liệu hợp đồng + điều kiện trong bytecode + luật dự án đã biết.
export function rulesFor(info, extra = {}) {
  const k = KNOWN[info.address?.toLowerCase()];
  const auto = [];
  if (info.maxSupply != null) auto.push(`Tổng cung ${fmt(info.maxSupply)} (số đã mint xem ở dòng "Đã mint", cập nhật trực tiếp).`);
  else if (info.totalSupply != null) auto.push(`Đã mint ${fmt(info.totalSupply)} (hợp đồng không công bố tổng cung).`);
  if (info.maxPerWallet != null) auto.push(`Tối đa ${fmt(info.maxPerWallet)} NFT mỗi ví${info.walletMinted != null ? `, ví bạn đã có ${fmt(info.walletMinted)}` : ''}.`);
  if (info.maxPerTx != null) auto.push(`Tối đa ${fmt(info.maxPerTx)} NFT mỗi giao dịch.`);
  if (extra.priceText) auto.push(`Giá: ${extra.priceText}.`);
  if (extra.walletPriceText && extra.walletPriceText !== extra.priceText) auto.push(`Giá lần mint tới của ví bạn: ${extra.walletPriceText}.`);
  if (info.startAt) auto.push(`Mở mint lúc ${new Date(info.startAt * 1000).toISOString().replace('T', ' ').slice(0, 16)} UTC.`);
  if (info.mintOpen === false) auto.push('Hợp đồng đang báo mint ĐÓNG.');
  if (info.paused === true) auto.push('Hợp đồng đang TẠM DỪNG.');
  const c = contractRules(info);
  const needsAgent = k?.needsAgentId || info.usesAgentId || c.rules.some((r) => r.includes('Agent ID'));
  if (needsAgent && info.hasAgentId === false) auto.push('⚠ Dự án cần Agent ID mà ví bạn CHƯA có: mint sẽ bị từ chối.');
  return {
    project: k?.name ?? null, site: k?.site ?? null, setBonus: k?.setBonus ?? null, publicSupply: k?.publicSupply ?? null,
    needsAgentId: needsAgent || null,
    auto, checks: c.rules, untranslated: c.untranslated, rules: k?.rules ?? [],
  };
}

// ---------- Nguồn 3: trang web dự án ----------

const ipfs = (u) => (u?.startsWith('ipfs://') ? 'https://ipfs.io/ipfs/' + u.slice(7) : u);
// Chỉ tải https tới tên miền công khai: chặn localhost / IP mạng nội bộ (hợp đồng lạ có thể cài link độc).
function safeUrl(u) {
  try {
    const url = new URL(ipfs(u));
    if (url.protocol !== 'https:' || url.port) return null;
    const h = url.hostname;
    if (/^(localhost|.*\.local|.*\.internal)$/i.test(h) || /^[\d.]+$/.test(h) || h.includes(':')) return null;
    return url.toString();
  } catch { return null; }
}

async function fetchText(u, fetchFn, max = 600_000) {
  const url = safeUrl(u);
  if (!url) return null;
  const r = await fetchFn(url, { redirect: 'follow', signal: AbortSignal.timeout(7000), headers: { accept: 'text/html,application/json' } });
  if (!r.ok) return null;
  const t = await r.text();
  return t.slice(0, max);
}

async function readJsonUri(uri, fetchFn) {
  if (!uri) return null;
  if (uri.startsWith('data:application/json;base64,')) return JSON.parse(Buffer.from(uri.split(',')[1], 'base64').toString('utf8'));
  if (uri.startsWith('data:application/json')) return JSON.parse(decodeURIComponent(uri.slice(uri.indexOf(',') + 1)));
  const t = await fetchText(uri, fetchFn, 200_000);
  return t ? JSON.parse(t) : null;
}

const decode = (s) => s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
const strip = (h) => decode(h.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

// Hàm thuần: tìm mục Rules / How to mint / Mint details... trên trang, lấy các dòng <li> (hoặc <p>) ngay sau tiêu đề.
export function extractRules(html) {
  const clean = html.replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, '');
  const heads = [...clean.matchAll(/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/gi)];
  const KEY = /rule|how to mint|mint (details|info|rules)|minting|eligib|requirement|tokenomics|supply|faq|luật|规则|铸造/i;
  const out = [];
  for (let i = 0; i < heads.length && out.length < 12; i++) {
    if (!KEY.test(strip(heads[i][1]))) continue;
    const start = heads[i].index + heads[i][0].length;
    const end = heads[i + 1]?.index ?? Math.min(clean.length, start + 20_000);
    const block = clean.slice(start, end);
    let items = [...block.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map((m) => strip(m[1]));
    if (!items.length) items = [...block.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => strip(m[1]));
    for (const t of items) if (t.length >= 8 && t.length <= 400 && !out.includes(t)) out.push(t);
  }
  return out.slice(0, 12);
}

// Dịch sang tiếng Việt qua Google Translate (endpoint công khai, không cần key). Lỗi thì giữ nguyên bản gốc.
const tcache = new Map();
export async function translateVi(texts, fetchFn = fetch) {
  const out = [];
  for (const t of texts) {
    if (!t || /[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệịỉĩọỏốồổỗộớờởỡợụủứừửữựỳỷỹ]/i.test(t)) { out.push(t); continue; } // đã là tiếng Việt
    if (tcache.has(t)) { out.push(tcache.get(t)); continue; }
    try {
      const u = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=vi&dt=t&q=${encodeURIComponent(t)}`;
      const j = await (await fetchFn(u, { signal: AbortSignal.timeout(6000) })).json();
      const vi = (j?.[0] ?? []).map((x) => x?.[0] ?? '').join('').trim() || t;
      tcache.set(t, vi);
      out.push(vi);
    } catch { out.push(t); }
  }
  return out;
}

// Dịch giao diện sang ngôn ngữ khác (en / zh-CN) cho người dùng nước ngoài. Lỗi thì giữ nguyên.
const ucache = new Map();
// Thuật ngữ giữ nguyên (dịch máy hay dịch sai: "Agent" thành "đặc vụ", "mint" thành "bạc hà"...).
const GLOSSARY = {
  'zh-CN': [[/(特工|代理人?|经纪人|智能体)\s*ID/g, 'Agent ID'], [/(代理|智能体)钱包/g, 'Agentic Wallet'], [/薄荷/g, '铸造'], [/铸币/g, '铸造'], [/宝石/g, '宝藏']],
  en: [[/\bagent ID\b/gi, 'Agent ID']],
};
// Chạy 3 yêu cầu cùng lúc (gửi dồn 40 cái dễ bị Google chặn). Lỗi trả về null để giao diện thử lại sau.
export async function translateTo(texts, tl, fetchFn = fetch) {
  const { mapLimit } = await import('./chain.js');
  return mapLimit(texts, 3, async (t) => {
    const k = `${tl}|${t}`;
    if (ucache.has(k)) return ucache.get(k);
    try {
      const u = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=vi&tl=${tl}&dt=t&q=${encodeURIComponent(t)}`;
      const j = await (await fetchFn(u, { signal: AbortSignal.timeout(6000) })).json();
      let r = (j?.[0] ?? []).map((x) => x?.[0] ?? '').join('') || t;
      for (const [re, to] of GLOSSARY[tl] ?? []) r = r.replace(re, to);
      if (ucache.size > 5000) ucache.clear();
      ucache.set(k, r);
      return r;
    } catch { return null; }
  });
}

const metaI = new Interface(['function contractURI() view returns (string)', 'function tokenURI(uint256) view returns (string)', 'function uri(uint256) view returns (string)']);

// Hàm thuần: link X (Twitter) của dự án trong metadata hoặc trang web. Bỏ link chia sẻ/tìm kiếm/bài viết.
export function extractX(html = '', meta = {}) {
  const fromMeta = meta?.twitter ?? meta?.x ?? meta?.twitter_url ?? meta?.links?.twitter;
  const cands = [fromMeta, ...[...String(html).matchAll(/https?:\/\/(?:www\.)?(?:x|twitter)\.com\/[A-Za-z0-9_]{1,15}(?=["'?/#\s<]|$)/g)].map((m) => m[0])];
  for (const c of cands) {
    if (!c) continue;
    const handle = String(c).startsWith('@') ? String(c).slice(1) : String(c).match(/(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})/)?.[1] ?? (/^[A-Za-z0-9_]{1,15}$/.test(c) ? c : null);
    if (handle && !/^(intent|share|search|home|i|hashtag|explore|login|signup|settings|x|twitter)$/i.test(handle)) return `https://x.com/${handle}`;
  }
  return null;
}

// Metadata + trang web dự án, dùng chung cho luật và link X. Lưu đệm 30 phút.
const pcache = new Map();
export async function projectPage(provider, address, fetchFn = fetch) {
  const key = address.toLowerCase();
  if (pcache.has(key) && Date.now() - pcache.get(key).at < 30 * 60_000) return pcache.get(key).v;
  const v = { site: KNOWN[key]?.site ?? null, description: null, html: '', x: KNOWN[key]?.x ?? null };
  // Metadata: contractURI() trước, không có thì tokenURI của token đầu tiên.
  let meta = null;
  for (const [fn, args] of [['contractURI', []], ['tokenURI', [1n]], ['tokenURI', [0n]], ['uri', [1n]]]) {
    const uri = await tryCall(provider, address, metaI, fn, args);
    if (!uri) continue;
    try { meta = await readJsonUri(String(uri).replace('{id}', '1'.padStart(64, '0')), fetchFn); } catch {}
    if (meta) break;
  }
  if (meta) {
    v.site ??= safeUrl(meta.external_link ?? meta.external_url ?? meta.website ?? '') ?? null;
    if (meta.description) v.description = String(meta.description).slice(0, 600);
  }
  if (v.site) { try { v.html = (await fetchText(v.site, fetchFn)) ?? ''; } catch {} }
  v.x ??= extractX(v.html, meta ?? {}) ?? extractX(v.description ?? '');
  v.perWallet = rememberSite(address, `${strip(v.html.replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ''))} ${v.description ?? ''}`);
  pcache.set(key, { at: Date.now(), v });
  return v;
}

// Luật đầy đủ (chậm hơn, cần mạng ngoài): trang dự án → mục luật → dịch.
const wcache = new Map();
export async function webRules(provider, address, info = {}, fetchFn = fetch) {
  const key = address.toLowerCase();
  if (wcache.has(key) && Date.now() - wcache.get(key).at < 30 * 60_000) return wcache.get(key).v;
  const page = await projectPage(provider, address, fetchFn);
  const res = { site: page.site, x: page.x, description: page.description, rules: page.html ? extractRules(page.html) : [], checks: [] };
  const [desc, ...rest] = await translateVi([res.description, ...res.rules, ...contractRules(info).untranslated], fetchFn);
  res.description = desc;
  res.rules = rest.slice(0, res.rules.length);
  res.checks = rest.slice(res.rules.length).map((x) => `Hợp đồng chặn khi: ${x}`);
  wcache.set(key, { at: Date.now(), v: res });
  return res;
}
