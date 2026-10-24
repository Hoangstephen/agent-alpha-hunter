// Báo NFT hot / hidden gem về Telegram. Chỉ BÁO, không bao giờ mint: mint luôn cần bạn tự bấm xác nhận.
// Token bot và chat id lấy từ biến môi trường TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID,
// hoặc file data/telegram.json (tạo bằng lệnh: node src/index.js telegram-setup). Không chia sẻ file này.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const PATH = 'data/telegram.json';
const SENT = 'data/alerted.json';
const API = 'https://api.telegram.org';

export function telegramConfig(cfg = {}, path = PATH) {
  let saved = {};
  try { saved = JSON.parse(readFileSync(path, 'utf8')); } catch {}
  const t = { ...(cfg.telegram ?? {}), ...saved };
  return {
    token: process.env.TELEGRAM_BOT_TOKEN || t.botToken || '',
    chatId: process.env.TELEGRAM_CHAT_ID || t.chatId || '',
    minHot: Number(process.env.TELEGRAM_MIN_HOT || t.minHot || 50), // chỉ báo NFT có điểm Hot từ mức này (Gem luôn báo)
    lang: process.env.TELEGRAM_LANG || t.lang || 'vi', // vi | en | zh
    repeatHours: Number(t.repeatHours || 6), // cùng 1 NFT không báo lại trong N giờ
  };
}
export const telegramReady = (t) => Boolean(t.token && t.chatId);

export function saveTelegram({ botToken, chatId, ...rest }, path = PATH) {
  mkdirSync('data', { recursive: true });
  writeFileSync(path, JSON.stringify({ botToken, chatId: String(chatId), ...rest }, null, 2));
}

// Token không bao giờ xuất hiện trong log/lỗi.
const hide = (s, token) => String(s).split(token).join('<token>');

export async function tgCall(token, method, body, fetchFn = fetch) {
  const r = await fetchFn(`${API}/bot${token}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}), signal: AbortSignal.timeout(15_000),
  }).catch((e) => { throw new Error(hide(e.message, token)); });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(`Telegram: ${hide(j.description ?? r.status, token)}`);
  return j.result;
}

export const sendTelegram = (t, text, fetchFn) => tgCall(t.token, 'sendMessage', { chat_id: t.chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }, fetchFn);

// Lấy chat id từ tin nhắn gần nhất người dùng gửi cho bot (bước cài đặt).
export async function findChats(token, fetchFn) {
  const ups = await tgCall(token, 'getUpdates', {}, fetchFn);
  const chats = new Map();
  for (const u of ups) {
    const c = (u.message ?? u.channel_post ?? u.my_chat_member)?.chat;
    if (c) chats.set(String(c.id), c.title || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.username || c.type);
  }
  return [...chats].map(([id, name]) => ({ id, name }));
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const L = {
  vi: { gem: '💎 Hidden gem', hot: '🔥 NFT đang hot', price: 'Giá', free: 'Miễn phí', paid: 'Người khác trả', minted: 'Đã mint', perWallet: 'Tối đa/ví', minters: 'Ví mint ~10 phút', agent: 'Ví có Agent ID', safety: 'An toàn', fake: '⚠️ CÓ THỂ LÀ HÀNG NHÁI: trùng tên với hợp đồng nhiều người mint hơn', agentOnly: 'Chỉ ví có Agent ID (.ai) mint được', unknown: '?', note: 'Chỉ là cảnh báo, bot không tự mint. NFA · DYOR', search: 'Tìm trên X' },
  en: { gem: '💎 Hidden gem', hot: '🔥 Hot NFT', price: 'Price', free: 'Free', paid: 'Others paid', minted: 'Minted', perWallet: 'Max/wallet', minters: 'Minters ~10 min', agent: 'Agent ID wallets', safety: 'Safety', fake: '⚠️ POSSIBLE FAKE: same name as a contract with more mints', agentOnly: 'Only Agent ID (.ai) wallets can mint', unknown: '?', note: 'Alert only, the bot never mints on its own. NFA · DYOR', search: 'Search on X' },
  zh: { gem: '💎 宝藏项目', hot: '🔥 热门 NFT', price: '价格', free: '免费', paid: '他人支付', minted: '已铸造', perWallet: '每钱包上限', minters: '约10分钟铸造钱包', agent: 'Agent ID 钱包', safety: '安全分', fake: '⚠️ 可能是仿冒：与铸造更多的合约同名', agentOnly: '仅持有 Agent ID (.ai) 的钱包可铸造', unknown: '?', note: '仅为提醒，机器人不会自动铸造。NFA · DYOR', search: '在 X 上搜索' },
};

export function formatAlert(n, lang = 'vi') {
  const t = L[lang] ?? L.vi;
  const price = n.priceBNB == null ? t.unknown : Number(n.priceBNB) === 0 ? t.free : `${n.priceBNB} BNB`;
  const paid = n.paid ? (n.paid.free ? t.free : `${n.paid.priceBNB} BNB`) : null;
  const supply = n.minted != null ? `${n.minted}${n.maxSupply ? ' / ' + n.maxSupply : ''}` : n.mints ? `≥${n.mints}` : t.unknown;
  const lines = [
    `<b>${n.gem ? t.gem : t.hot}: ${esc(n.name || '???')}</b>${n.hot != null ? ` · 🔥 ${n.hot}` : ''}`,
    `<code>${esc(n.address)}</code>`,
    n.lookalike ? `<b>${t.fake}</b> (${esc(n.lookalike.of)})` : null,
    `${t.price}: <b>${esc(price)}</b>${paid ? ` · ${t.paid}: ${esc(paid)}` : ''}`,
    `${t.minted}: ${esc(supply)} · ${t.perWallet}: ${esc(n.maxPerWallet ?? t.unknown)}`,
    n.uniqueMinters != null ? `${t.minters}: ${n.uniqueMinters} · ${t.agent}: ${Math.round((n.agentRatio ?? 0) * 100)}%` : null,
    `${t.safety}: ${n.risk ?? t.unknown}/100`,
    n.gem || n.agentMint ? t.agentOnly : null,
    `<a href="https://bscscan.com/address/${esc(n.address)}">BscScan</a> · <a href="https://x.com/search?q=${encodeURIComponent(n.address)}&amp;f=live">${t.search}</a>${n.projectX ? ` · <a href="${esc(n.projectX)}">X</a>` : ''}`,
    `<i>${t.note}</i>`,
  ];
  return lines.filter(Boolean).join('\n');
}

// Chọn NFT cần báo: điểm Hot đủ cao hoặc là Gem, chưa báo trong repeatHours giờ qua, không bị chặn cứng (điểm an toàn < 40).
export function pickAlerts(nfts, t, sent = {}, now = Date.now()) {
  return nfts.filter((n) => {
    if (n.partial || n.risk == null || n.risk < 40) return false;
    if (!(n.gem || (n.hot ?? 0) >= t.minHot)) return false;
    const last = sent[n.address.toLowerCase()];
    return !last || now - last > t.repeatHours * 3600_000;
  });
}

// Gọi sau mỗi lượt quét (web và chế độ VPS dùng chung).
export async function notifyScan(scan, cfg, log = console.log, { fetchFn, sentPath = SENT } = {}) {
  const t = telegramConfig(cfg);
  if (!telegramReady(t) || !scan?.nfts?.length) return 0;
  let sent = {};
  try { sent = JSON.parse(readFileSync(sentPath, 'utf8')); } catch {}
  const list = pickAlerts(scan.nfts, t, sent);
  let n = 0;
  for (const x of list.slice(0, 5)) { // tối đa 5 tin mỗi lượt để không bị Telegram chặn spam
    try {
      await sendTelegram(t, formatAlert(x, t.lang), fetchFn);
      sent[x.address.toLowerCase()] = Date.now();
      n += 1;
    } catch (e) { log(`[telegram] lỗi gửi: ${e.message}`); break; }
  }
  if (n) {
    for (const [k, v] of Object.entries(sent)) if (Date.now() - v > 7 * 86400_000) delete sent[k];
    mkdirSync('data', { recursive: true });
    writeFileSync(sentPath, JSON.stringify(sent));
    log(`[telegram] đã báo ${n} NFT`);
  }
  return n;
}
