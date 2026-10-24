// Tự đăng bán: NFT mới về ví được bot đăng bán trên Element theo giá bạn đặt sẵn quy tắc.
// TẮT mặc định. Bật trên giao diện (mục Bán NFT) hoặc file data/autosell.json.
// Giá đăng = cao nhất trong: giá bán trung vị gần đây, giá mint x (1 + % lời), giá sàn bạn đặt.
// Không có dữ liệu giá nào thì bỏ qua NFT đó (không bao giờ đoán giá).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { formatEther } from 'ethers';
import { buildListing, checkListing, signListing, postListing, previewApproveElement } from './list.js';
import { executeApprove, waitReceipt } from './mint.js';
import { Ledger } from './ledger.js';
import { sellReport } from './sell.js';
import { watchList } from './watch.js';
import { telegramConfig, telegramReady, sendTelegram } from './telegram.js';

const PATH = 'data/autosell.json';
const LISTED = 'data/listed.json';
export const AUTO_DEFAULTS = { enabled: false, markupPct: 30, minPriceBNB: 0, days: 7, maxPerRun: 5, everyMin: 15 };

const readJson = (p, d) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return d; } };
const writeJson = (p, v) => { mkdirSync('data', { recursive: true }); writeFileSync(p, JSON.stringify(v, null, 2)); };

export const autoSellConfig = (path = PATH) => ({ ...AUTO_DEFAULTS, ...readJson(path, {}) });
export function saveAutoSell(v, path = PATH) {
  const c = { ...autoSellConfig(path) };
  if (v.enabled != null) c.enabled = Boolean(v.enabled);
  for (const k of ['markupPct', 'minPriceBNB', 'days', 'maxPerRun', 'everyMin']) if (v[k] != null && v[k] !== '' && Number.isFinite(Number(v[k])) && Number(v[k]) >= 0) c[k] = Number(v[k]);
  c.days = Math.min(90, Math.max(1, c.days));
  c.maxPerRun = Math.min(20, Math.max(1, c.maxPerRun));
  c.everyMin = Math.max(5, c.everyMin);
  writeJson(path, c);
  return c;
}

export const listedMap = (path = LISTED) => readJson(path, {});
export function markListed(key, row, path = LISTED) {
  const m = listedMap(path);
  m[key] = { ...row, at: new Date().toISOString() };
  writeJson(path, m);
}
const isListed = (m, key, now = Date.now()) => m[key] && Date.parse(m[key].expiresAt) > now;

// Giá mint 1 NFT của hợp đồng này (từ sổ mint của bot), tính bằng BNB.
export function mintCostBNB(contract, rows = new Ledger().rows) {
  const r = [...rows].reverse().find((x) => x.target?.toLowerCase() === contract.toLowerCase() && Number(x.qty) > 0);
  return r ? Number(formatEther(BigInt(r.valueWei))) / Number(r.qty) : null;
}

const up4 = (x) => Math.ceil(x * 10_000) / 10_000;
export function suggestPrice({ medianBNB, costBNB }, a) {
  const c = [];
  if (medianBNB > 0) c.push(medianBNB);
  if (costBNB > 0) c.push(costBNB * (1 + a.markupPct / 100));
  if (!c.length) return null; // không có dữ liệu giá: không đăng
  if (a.minPriceBNB > 0) c.push(a.minPriceBNB);
  return up4(Math.max(...c));
}

// Đăng 1 NFT không cần bấm (chế độ tự bán). Cấp quyền cho sàn nếu cần, rồi ký + gửi.
export async function listNow(provider, cfg, { maker, contract, tokenId, priceBNB, days, minPriceBNB = 0, log = () => {} }) {
  let l = await buildListing(provider, cfg, { maker, contract, tokenId, priceBNB, days });
  if (l.needsApproval) {
    const pa = previewApproveElement(cfg, maker, contract);
    if (!pa.ok) throw new Error(pa.error);
    if (pa.requireConfirmation) throw new Error('Binance yêu cầu duyệt cấp quyền trong app: đăng bán tay 1 lần trên giao diện');
    const r = executeApprove(pa.requestId);
    if (!r.ok || !r.txHash) throw new Error(r.error ?? 'Cấp quyền cho Element chưa xong');
    log(`[bán] cấp quyền Element cho ${contract}: ${r.txHash}`);
    if (!(await waitReceipt(provider, r.txHash))) throw new Error('Cấp quyền chưa được xác nhận trên chain');
    l = await buildListing(provider, cfg, { maker, contract, tokenId, priceBNB, days });
  }
  const errs = checkListing(l, { maker, contract, tokenId, priceBNB, minPriceBNB });
  if (errs.length) throw new Error(errs.join(' · '));
  const sig = await signListing(cfg, maker, l.typedData);
  const posted = await postListing(cfg, l.typedData, sig);
  markListed(`${contract.toLowerCase()}:${tokenId}`, { priceBNB: l.priceBNB, receiveBNB: l.receiveBNB, orderId: posted.orderId, expiresAt: l.expiresAt });
  return { ...posted, priceBNB: l.priceBNB, receiveBNB: l.receiveBNB };
}

// Một lượt tự bán trên kết quả sellReport. Trả về danh sách đã đăng.
export async function autoSellRun(provider, cfg, report, { log = console.log, a = autoSellConfig(), listFn = listNow, notify = async () => {} } = {}) {
  if (!a.enabled || !cfg.elementKey || !report?.holdings?.length) return [];
  const listed = listedMap();
  const done = [];
  for (const h of report.holdings) {
    const costBNB = mintCostBNB(h.contract);
    for (const it of h.items ?? []) {
      if (done.length >= a.maxPerRun) return done;
      if (it.tokenId == null) continue;
      const key = `${h.contract.toLowerCase()}:${it.tokenId}`;
      if (isListed(listed, key)) continue;
      const priceBNB = suggestPrice({ medianBNB: h.sales?.medianBNB, costBNB }, a);
      if (!priceBNB) { log(`[tự bán] bỏ qua ${h.name ?? h.contract} #${it.tokenId}: chưa có giá tham khảo`); continue; }
      try {
        const r = await listFn(provider, cfg, { maker: report.wallet, contract: h.contract, tokenId: it.tokenId, priceBNB, days: a.days, minPriceBNB: a.minPriceBNB, log });
        log(`[tự bán] đã đăng ${h.name ?? h.contract} #${it.tokenId} giá ${priceBNB} BNB (nhận về ~${r.receiveBNB} BNB)`);
        done.push({ name: h.name, contract: h.contract, tokenId: it.tokenId, ...r });
        await notify(done.at(-1)).catch(() => {});
      } catch (e) {
        log(`[tự bán] ${h.name ?? h.contract} #${it.tokenId}: ${e.message}`);
        markListed(key, { failed: e.message, expiresAt: new Date(Date.now() + 3600_000).toISOString() }); // thử lại sau 1 giờ
      }
    }
  }
  return done;
}

const esc = (x) => String(x ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const listedText = (r) => `🏷 <b>Đã tự đăng bán</b>: ${esc(r.name ?? r.contract)} #${esc(r.tokenId)}\nGiá: <b>${r.priceBNB} BNB</b> · nhận về ~${r.receiveBNB} BNB\n<a href="${esc(r.url)}">Xem trên Element</a>`;

// Gọi định kỳ (web và VPS): đọc NFT trong ví rồi đăng bán những cái chưa đăng.
export async function autoSellTick(provider, cfg, walletAddr, { scanNfts = [], bnbUsdt, log = console.log } = {}) {
  const a = autoSellConfig();
  if (!a.enabled || !cfg.elementKey || !walletAddr) return [];
  const rows = new Ledger().rows;
  const contracts = [...rows.map((r) => r.target), ...watchList(), ...scanNfts.map((n) => n.address)].filter(Boolean);
  const report = await sellReport(provider, cfg, walletAddr, contracts, { bnbUsdt, log: () => {}, mintTxs: rows });
  const t = telegramConfig(cfg);
  return autoSellRun(provider, cfg, report, { log, a, notify: (r) => (telegramReady(t) ? sendTelegram(t, listedText(r)) : Promise.resolve()) });
}
