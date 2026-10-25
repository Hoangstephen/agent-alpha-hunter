#!/usr/bin/env node
// Giao diện web chạy trên máy bạn: http://127.0.0.1:3777
// Chỉ nghe ở 127.0.0.1, và chỉ nhận request từ chính trang này.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { formatEther, formatUnits, Interface, parseEther } from 'ethers';
import { loadConfig } from './config.js';
import { connect, testRpc } from './chain.js';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { scanAll, summarize, markLookalikes } from './scanner.js';
import { inspectContract, probeValue, MINTED_GETTERS } from './risk.js';
import { tryCall, getLogsChunked } from './chain.js';
import { prepareMint, previewMint, executeMint, previewApprove, executeApprove, waitReceipt, buildCall } from './mint.js';
import { Ledger } from './ledger.js';
import { bnbUsdt } from './price.js';
import { sellReport } from './sell.js';
import { lpLock } from './lp.js';
import { findMarkets, trustMarket, findInstantSell, approveMarketData, approveTokenData, revokeMarketData, marketApproved, previewMarketCall, learnMarket, findListCall, markBadCall, onchainListings } from './markets.js';
import { buildListing, checkListing, signListing, postListing, previewApproveElement, elementApi } from './list.js';
import { autoSellConfig, saveAutoSell, autoSellTick, listedMap, markListed, mintCostBNB, suggestPrice } from './autosell.js';
import { webRules, projectPage, translateTo } from './rules.js';
import { notifyScan } from './telegram.js';
import { watchList, watchAdd } from './watch.js';
import { resolveAgentId, saveAgentName, labelOf, validLabel } from './agentid.js';
import { isAddress, getAddress } from 'ethers';
import * as wallet from './baw.js';

const PORT = Number(process.env.PORT || 3777);
const ORIGINS = [`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`];
const PREVIEW_TTL_MS = 4 * 60_000; // preview của Binance hết hạn sau ~5 phút
const SCAN_EVERY_MS = 5 * 60_000;

const cfg = loadConfig();

// Mint nâng cao: chỉ nhận chữ ký hàm kiểu "mint(uint256,uint256)" và tham số là số / địa chỉ / true-false.
const ADV_TYPE = '(uint\\d{0,3}|int\\d{0,3}|address|bool|bytes32)';
const ADV_FN = new RegExp(`^[A-Za-z_][A-Za-z0-9_]{0,40}\\((${ADV_TYPE}(,${ADV_TYPE}){0,5})?\\)$`);
function checkAdv({ fn, args = [], valueBnb }) {
  if (!ADV_FN.test(String(fn ?? ''))) return 'Tên hàm không hợp lệ. Ví dụ: mint(uint256,uint256)';
  if (!Array.isArray(args) || args.length > 6) return 'Tham số phải là danh sách, tối đa 6 giá trị';
  if (args.some((a) => !(typeof a === 'boolean' || /^(0x[0-9a-fA-F]{1,64}|\d{1,78})$/.test(String(a))))) return 'Tham số chỉ được là số, địa chỉ 0x… hoặc true/false';
  if (valueBnb != null && valueBnb !== '' && !/^\d{1,3}(\.\d{1,18})?$/.test(String(valueBnb))) return 'Số BNB không hợp lệ';
  return null;
}
const logs = [];
const log = (m) => { logs.push(`${new Date().toLocaleTimeString()} ${m}`); if (logs.length > 200) logs.shift(); console.log(m); };
const state = { infoCache: new Map(), provider: null, scan: null, scanning: false, progress: null, lastScanMs: null, pending: new Map(), price: null, login: null, install: null };
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const big = (_, v) => (typeof v === 'bigint' ? v.toString() : v);

// Địa chỉ ví Agentic dùng lần gần nhất (chỉ là địa chỉ công khai): phiên ví hết hạn vẫn xem được NFT và giá.
function lastWallet() { try { return JSON.parse(readFileSync('data/last-wallet.json', 'utf8')).address ?? null; } catch { return null; } }
function walletInfo() {
  try {
    let status;
    try { status = wallet.walletStatus(); } catch (e) { if (e.code === 'BAW_MISSING') throw e; status = wallet.walletStatus(); } // lỗi thoáng qua: thử lại 1 lần
    if (status !== 'CONNECTED') return { installed: true, connected: false, status, last: lastWallet(), hint: `Phiên ví Agentic ${status ? `đang ở trạng thái ${status}` : 'chưa có'}: bấm "Đăng nhập ví" rồi quét QR trong app Binance` };
    const address = cfg.walletAddress || wallet.bscAddress(cfg.binanceChainId);
    if (address && address !== lastWallet()) { try { mkdirSync('data', { recursive: true }); writeFileSync('data/last-wallet.json', JSON.stringify({ address })); } catch {} }
    return { installed: true, connected: true, address, devMode: wallet.devModeEnabled() };
  } catch (e) {
    return { installed: e.code !== 'BAW_MISSING', connected: false, last: lastWallet(), hint: e.message };
  }
}

// Đăng nhập: auth signin → hiện mã ghép đôi + link QR → auth verify chạy nền tới khi bạn xác nhận trong app.
async function startLogin() {
  if (state.login?.pending) return state.login;
  const r = wallet.signin();
  if (!r.success) return (state.login = { pending: false, error: r.error?.message ?? 'Đăng nhập lỗi' });
  if (r.data?.status === 'ALREADY_CONNECTED') return (state.login = { pending: false, done: true });
  const { urlForWeb, qrCodeId, pairingCode, expireAt } = r.data;
  state.login = { pending: true, pairingCode, url: urlForWeb, expireAt: Number(expireAt) };
  openBrowser(urlForWeb);
  wallet.verify(qrCodeId)
    .then((v) => { state.login = v.success ? { pending: false, done: true } : { pending: false, error: v.error?.message ?? 'Mã QR hết hạn, bấm Đăng nhập lại.' }; })
    .catch((e) => { state.login = { pending: false, error: e.message }; })
    .finally(() => log(`[ví] đăng nhập: ${state.login.done ? 'thành công' : state.login.error}`));
  return state.login;
}

function startInstall() {
  if (state.install?.running) return state.install;
  state.install = { running: true, lines: [] };
  log(`[ví] đang cài ${wallet.BAW_PACKAGE}…`);
  wallet.install((l) => { state.install.lines.push(l); state.install.lines = state.install.lines.slice(-8); })
    .then((r) => { state.install = { ...state.install, running: false, ...r }; log(`[ví] cài baw: ${r.ok ? 'xong' : r.error}`); });
  return state.install;
}

async function runScan() {
  if (state.scanning) return;
  state.scanning = true;
  try {
    const w = walletInfo();
    let v = 0;
    const onProgress = (p) => {
      state.progress = p;
      // Hiện kết quả từng phần ngay, giữ lại bản quét trước nếu bản mới chưa có gì.
      if (p.result && (p.result.nfts.length || !state.scan)) state.scan = { ...p.result, scannedAt: `partial-${++v}` };
    };
    state.scan = await scanAll(state.provider, cfg, log, { walletAddr: w.connected ? w.address : undefined, bnbUsdt: state.price?.price, onProgress });
    state.lastScanMs = state.scan.durationMs;
    log(`[scan] xong: ${state.scan.nfts.length} NFT, ${state.scan.tokens.length} token gang.fun`);
    notifyScan(state.scan, cfg, log).catch((e) => log(`[telegram] ${e.message}`));
  } catch (e) {
    log(`[scan] lỗi: ${e.message}`);
  } finally {
    state.scanning = false;
    state.progress = null;
    state.nextScanAt = Date.now() + SCAN_EVERY_MS; // quét tay cũng tính lại mốc 5 phút
  }
}

// Tự đăng bán (nếu bật): chạy mỗi everyMin phút, không chạy chồng lượt.
async function runAutoSell() {
  const a = autoSellConfig();
  if (!a.enabled || state.autoSelling || (state.nextAutoSellAt && Date.now() < state.nextAutoSellAt)) return;
  state.autoSelling = true;
  state.nextAutoSellAt = Date.now() + a.everyMin * 60_000;
  try {
    const w = walletInfo();
    if (!w.connected) return;
    const done = await autoSellTick(state.provider, cfg, w.address, { scanNfts: state.scan?.nfts, bnbUsdt: state.price?.price, log });
    state.autoSell = { at: new Date().toISOString(), listed: done.length };
  } catch (e) {
    log(`[tự bán] lỗi: ${e.message}`);
  } finally {
    state.autoSelling = false;
  }
}

const api = {
  'GET /api/state': () => ({
    rpc: state.provider?.url, logsRpc: state.provider?.logsUrl, customRpc: Boolean(cfg.rpcUrl), scanning: state.scanning, progress: state.progress, lastScanMs: state.lastScanMs, nextScanAt: state.nextScanAt ?? null, scanEveryMin: SCAN_EVERY_MS / 60_000, scan: state.scan, logs: logs.slice(-15),
    limits: cfg.limits, spentTodayBNB: formatEther(new Ledger().spentTodayWei()),
    bnbUsdt: state.price?.price ?? null, priceSource: state.price?.source ?? null,
  }),
  // Tìm giá bán cao nhất cho NFT đang giữ: NFT đã mint qua bot + NFT đang hot + địa chỉ bạn thêm.
  'POST /api/sell': async ({ wallet: manual, extra = [] }) => {
    let addr = manual;
    let sessionNote = null;
    if (!addr) {
      const w = walletInfo();
      if (!w.connected && !w.last) return { ok: false, error: `${w.hint}. Hoặc dán địa chỉ ví để chỉ xem.` };
      // Phiên ví hết hạn: vẫn xem NFT + giá bằng địa chỉ ví lần trước, chỉ bán/đặt giá mới cần đăng nhập lại.
      if (!w.connected) sessionNote = `${w.hint}. Đang hiện NFT của ví ${w.last} (lần đăng nhập trước), đăng nhập lại để bán.`;
      addr = w.connected ? w.address : w.last;
    }
    if (!isAddress(addr)) return { ok: false, error: 'Địa chỉ ví không hợp lệ' };
    const contracts = [
      ...new Ledger().rows.map((r) => r.target),
      ...watchList(),
      ...(state.scan?.nfts ?? []).map((n) => n.address),
      ...extra.filter((a) => isAddress(a)),
    ];
    const r = await sellReport(state.provider, cfg, addr, contracts, { bnbUsdt: state.price?.price, log, mintTxs: new Ledger().rows });
    // Lệnh bán đang treo (bot đã đăng) + giá gợi ý để đăng bán.
    const listed = listedMap();
    const a = autoSellConfig();
    for (const h of r.holdings) {
      const suggest = suggestPrice({ medianBNB: h.sales?.medianBNB, costBNB: mintCostBNB(h.contract) }, a);
      // Lệnh rao bán trên chợ riêng, đọc từ chain (kể cả lệnh đặt bằng bản cũ / máy khác).
      const chainListed = new Map();
      if (!manual) for (const mk of (h.markets ?? []).filter((x) => x.trust)) {
        const m = await onchainListings(state.provider, mk.address, addr).catch(() => new Map());
        for (const [k, v] of m) chainListed.set(k, v);
      }
      for (const it of h.items ?? []) {
        const l = listed[`${h.contract.toLowerCase()}:${it.tokenId}`];
        if (l && !l.failed && Date.parse(l.expiresAt) > Date.now()) it.listed = l;
        const c = chainListed.get(String(it.tokenId));
        if (c && (!c.expiresAt || Date.parse(c.expiresAt) > Date.now())) it.listed = { ...it.listed, ...c }; // chain là nguồn đúng nhất
        if (it.listed?.market && !manual) it.listed.needsApprove = !(await marketApproved(state.provider, h.contract, addr, it.listed.market, it.tokenId, { perToken: true }));
        it.suggestBNB = suggest;
      }
    }
    return { ok: true, ...r, canList: Boolean(cfg.elementKey) && !manual && !sessionNote, readOnly: Boolean(manual || sessionNote), sessionNote };
  },
  // Element API key: thử gọi Element trước, chạy được mới lưu vào data/element.json. Để trống = xoá.
  'POST /api/element-key': async ({ key }) => {
    key = String(key ?? '').trim();
    if (!key) { rmSync('data/element.json', { force: true }); cfg.elementKey = process.env.ELEMENT_API_KEY || ''; return { ok: true, saved: false }; }
    if (!/^[\w-]{8,128}$/.test(key)) return { ok: false, error: 'Key không đúng định dạng' };
    try { await elementApi({ elementKey: key }, '/openapi/v1/orders/confData?chain=bsc'); } catch (e) { return { ok: false, error: `Element không nhận key: ${e.message}` }; }
    mkdirSync('data', { recursive: true });
    writeFileSync('data/element.json', JSON.stringify({ key }));
    cfg.elementKey = key;
    return { ok: true, saved: true };
  },
  // Bán ngay trên chợ riêng của dự án (chỉ chợ có cùng chủ với hợp đồng NFT). Bước 1: preview.
  'POST /api/market/preview': async ({ contract, tokenId, market, mode = 'sell', priceBNB }) => {
    const w = walletInfo();
    if (!w.connected) return { ok: false, error: w.hint };
    if (!isAddress(contract) || !isAddress(market) || !/^\d{1,78}$/.test(String(tokenId))) return { ok: false, error: 'Dữ liệu không hợp lệ' };
    const page = Promise.race([projectPage(state.provider, contract).catch(() => null), new Promise((r) => setTimeout(() => r(null), 8000))]);
    let m = (await findMarkets(state.provider, contract, { page }).catch(() => [])).find((x) => x.address.toLowerCase() === market.toLowerCase());
    if (!m) {
      // RPC lỗi lượt này: dùng chợ đã thấy lần trước, kiểm tra lại "cùng chủ" ngay trên chain.
      let c = {};
      try { c = JSON.parse(readFileSync('data/sell-cache.json', 'utf8')); } catch {}
      const old = (c[contract.toLowerCase()]?.markets ?? []).find((x) => x.address.toLowerCase() === market.toLowerCase());
      if (old) { const pg = await page; m = { ...old, trust: await trustMarket(state.provider, contract, old, { site: pg?.site, html: pg?.html }).catch(() => null) }; }
    }
    if (!m) return { ok: false, error: 'Không thấy chợ này trong các giao dịch gần đây của bộ NFT. Bấm Tìm giá bán cao nhất lại.' };
    if (!m.trust) return { ok: false, error: `Chợ này chưa đủ bằng chứng là chợ thật: khác chủ với hợp đồng NFT, web dự án không nhắc tới, và mới có ${m.buyers ?? 0} người mua trả BNB qua chợ (cần ≥ 5). Bot không cấp quyền. Bán trên web của chợ nếu bạn tin nó.`, site: m.site };
    const id = randomUUID();
    const base = { market: m.address, site: m.site, owner: m.trust.owner, trust: m.trust, contract, tokenId: String(tokenId) };
    // Luôn cấp quyền cho ĐÚNG NFT đang bán: approve(chợ, số token). Chợ chuẩn nào cũng nhận, an toàn hơn quyền cả bộ,
    // và có chợ (BN World) chỉ hiện/bán được NFT có quyền này. Quyền tự mất khi NFT được bán hoặc chuyển đi.
    if (!(await marketApproved(state.provider, contract, w.address, m.address, tokenId, { perToken: true }))) {
      const pv = await previewMarketCall(cfg, w.address, contract, approveTokenData(m.address, tokenId), { provider: state.provider, what: 'bước cấp quyền', log });
      if (!pv.ok) return pv;
      state.pending.set(id, { kind: 'mk-approve', requestId: pv.requestId, contract, tokenId: String(tokenId), market: m.address, approveOnly: mode === 'approve', at: Date.now() });
      return { ok: true, step: 'approve', scope: 'token', id, ...base, risks: pv.risks, needsAppApproval: pv.requireConfirmation };
    }
    if (mode === 'approve') return { ok: true, step: 'done', message: 'NFT này đã có quyền cho chợ.' };
    const learnedM = await learnMarket(state.provider, m.address, contract).catch(() => ({ sellSamples: [], listSamples: [] }));
    let call;
    if (mode === 'list') {
      if (!/^\d{1,6}(\.\d{1,18})?$/.test(String(priceBNB)) || Number(priceBNB) <= 0) return { ok: false, error: 'Nhập giá bán (BNB)' };
      call = await findListCall(state.provider, m.address, learnedM.listSamples, { me: w.address, tokenId, priceWei: parseEther(String(priceBNB)), nft: contract, single: learnedM.single });
      if (!call) return { ok: false, error: learnedM.listSamples.length
        ? 'Chợ từ chối lệnh đặt giá khi mô phỏng (có thể NFT đang được rao bán rồi, hoặc chợ đã đổi cách đặt). Thử trên web của chợ.'
        : 'Bot chưa đọc được giao dịch đặt giá nào trên chợ này, và các cách đặt giá phổ biến đều bị chợ từ chối khi mô phỏng. Đặt giá trên web của chợ.', site: m.site };
    } else {
      call = await findInstantSell(state.provider, { ...m, sellSamples: [...learnedM.sellSamples, ...(m.sellSamples ?? [])] }, { me: w.address, tokenId });
      if (!call) return { ok: false, error: 'Chưa có lệnh mua (offer) nào trên chợ nhận được NFT này lúc này: lệnh mua có thể chỉ dành cho số token khác hoặc đã có người bán vào. Dùng "Đặt giá bán" để rao bán thay.', site: m.site };
    }
    const pv = await previewMarketCall(cfg, w.address, m.address, call.data, { provider: state.provider, what: mode === 'list' ? 'lệnh đặt giá' : 'lệnh bán', log });
    if (!pv.ok) return pv;
    if (pv.extraPerms) return { ok: false, error: 'Giao dịch này kèm cấp thêm quyền cho bên khác: đã chặn.', risks: pv.risks };
    state.pending.set(id, { kind: mode === 'list' ? 'mk-list' : 'mk-sell', requestId: pv.requestId, contract, tokenId: String(tokenId), market: m.address, site: m.site ?? null, priceBNB: mode === 'list' ? Number(priceBNB) : null, data: call.data, at: Date.now() });
    return { ok: true, step: mode === 'list' ? 'list' : 'sell', id, ...base, priceBNB: mode === 'list' ? Number(priceBNB) : null, changes: pv.changes, risks: pv.risks, sample: call.sample, guessed: call.guessed ?? null, needsAppApproval: pv.requireConfirmation };
  },
  // Sau khi bán: thu hồi quyền cả bộ đã cấp cho chợ (giống "revoke mọi approval" sau khi bán).
  'POST /api/market/revoke': async ({ contract, market }) => {
    const w = walletInfo();
    if (!w.connected) return { ok: false, error: w.hint };
    if (!isAddress(contract) || !isAddress(market)) return { ok: false, error: 'Dữ liệu không hợp lệ' };
    if (!(await marketApproved(state.provider, contract, w.address, market))) return { ok: true, nothing: true };
    const pv = await previewMarketCall(cfg, w.address, contract, revokeMarketData(market), { provider: state.provider, what: 'lệnh thu hồi quyền', log });
    if (!pv.ok) return pv;
    const id = randomUUID();
    state.pending.set(id, { kind: 'mk-revoke', requestId: pv.requestId, contract, market: getAddress(market), at: Date.now() });
    return { ok: true, step: 'revoke', id, contract, market: getAddress(market), risks: pv.risks, needsAppApproval: pv.requireConfirmation };
  },
  'POST /api/market/execute': async ({ id }) => {
    const p = state.pending.get(id);
    state.pending.delete(id);
    if (!p || Date.now() - p.at > PREVIEW_TTL_MS || !String(p.kind).startsWith('mk-')) return { ok: false, error: 'Lệnh đã hết hạn, bấm Bán ngay lại.' };
    const r = executeApprove(p.requestId); // cùng lệnh contract-call execute
    if (!r.ok) return r;
    if (!r.txHash) return { ok: true, next: 'retry', message: 'Duyệt giao dịch trong app Binance, rồi bấm lại.' };
    log(`[bán] ${p.kind === 'mk-revoke' ? `thu hồi quyền chợ ${p.market} cho ${p.contract}` : p.kind === 'mk-approve' ? `cấp quyền chợ ${p.market} cho ${p.contract}` : `${p.kind === 'mk-list' ? 'đặt giá bán' : 'bán'} ${p.contract} #${p.tokenId} trên chợ ${p.market}`}: ${r.txHash}`);
    const done = await waitReceipt(state.provider, r.txHash, { timeoutMs: 60_000 });
    if (p.kind === 'mk-approve') return done ? (p.approveOnly ? { ok: true, txHash: r.txHash, confirmed: true, kind: 'mk-approve' } : { ok: true, next: 'sell' }) : { ok: false, error: 'Cấp quyền chưa được xác nhận trên chain, thử lại sau ít phút.' };
    if (p.kind === 'mk-revoke') return { ok: true, txHash: r.txHash, confirmed: done, kind: p.kind };
    let noMarketLog = false;
    if (p.kind === 'mk-list' && done) {
      // Chợ ghi lệnh rao bán thành sự kiện (log) của chính hợp đồng chợ. Không có log = giao dịch chạy nhưng có thể chợ không nhận lệnh.
      const rc = await state.provider.getTransactionReceipt(r.txHash).catch(() => null);
      noMarketLog = Boolean(rc) && !rc.logs.some((l) => l.address.toLowerCase() === p.market.toLowerCase());
      if (noMarketLog) {
        log(`[bán] ⚠ đặt giá ${p.contract} #${p.tokenId}: giao dịch thành công nhưng chợ ${p.market} không ghi sự kiện nào. Bot sẽ không dùng lại hàm ${p.data.slice(0, 10)} trên chợ này.`);
        // Hàm này từng tạo được lệnh rao bán (có sự kiện) thì lần này chỉ là đặt lại NFT đã rao: không đánh dấu hỏng.
        let before = Object.values(listedMap()).some((l) => l.market === p.market && l.selector === p.data.slice(0, 10));
        // Hoặc NFT này đã được rao trước đó (sự kiện cũ của chợ có số token + ví bạn, vd. Listed(tokenId, seller, …)).
        if (!before) {
          const head = await state.provider.getBlockNumber().catch(() => 0);
          const old = head ? await getLogsChunked(state.provider, { address: p.market, topics: [null, '0x' + BigInt(p.tokenId).toString(16).padStart(64, '0')] }, Math.max(0, head - 200_000), head, 5000, { deadlineMs: 20_000 }).catch(() => []) : [];
          const me = walletInfo().address?.toLowerCase().slice(2);
          before = old.some((l) => l.topics.some((t) => me && t.toLowerCase().endsWith(me)));
          if (before) markListed(`${p.contract.toLowerCase()}:${p.tokenId}`, { priceBNB: p.priceBNB, market: p.market, site: p.site, txHash: old.at(-1).transactionHash, selector: p.data.slice(0, 10), expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString() });
        }
        if (!before) markBadCall(p.market, p.data, 'không ghi sự kiện rao bán');
      }
      else markListed(`${p.contract.toLowerCase()}:${p.tokenId}`, { priceBNB: p.priceBNB, market: p.market, site: p.site, txHash: r.txHash, selector: p.data.slice(0, 10), expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString() });
    }
    // Bán xong mà chợ vẫn giữ quyền cả bộ: gợi ý thu hồi (đặt giá bán thì phải giữ quyền tới khi có người mua).
    const canRevoke = p.kind === 'mk-sell' && done && (await marketApproved(state.provider, p.contract, walletInfo().address, p.market));
    return { ok: true, txHash: r.txHash, confirmed: done, kind: p.kind, canRevoke, noMarketLog, site: p.site, contract: p.contract, market: p.market };
  },
  // LP của token có bị khoá/đốt không (pool PancakeSwap V2).
  'POST /api/lp': async ({ token, quote }) => {
    if (!isAddress(token)) return { ok: false, error: 'Địa chỉ token không hợp lệ' };
    return { ok: true, ...(await lpLock(state.provider, token, { quote: isAddress(quote) ? quote : undefined })) };
  },
  'GET /api/autosell': () => ({ ...autoSellConfig(), hasKey: Boolean(cfg.elementKey), last: state.autoSell ?? null }),
  'POST /api/autosell': (v) => {
    const c = saveAutoSell(v);
    log(`[tự bán] ${c.enabled ? `BẬT: giá ≥ max(trung vị gần đây, giá mint +${c.markupPct}%${c.minPriceBNB ? `, ${c.minPriceBNB} BNB` : ''}), tối đa ${c.maxPerRun} NFT/lượt` : 'TẮT'}`);
    if (c.enabled) state.nextAutoSellAt = Date.now() + 5000;
    return { ok: true, ...c, hasKey: Boolean(cfg.elementKey) };
  },
  // Đăng bán 1 NFT. Bước 1: tạo lệnh + kiểm tra, trả về tóm tắt (giá, phí, nhận về) để bạn xác nhận.
  'POST /api/list/preview': async ({ contract, tokenId, priceBNB, days }) => {
    const w = walletInfo();
    if (!w.connected) return { ok: false, error: w.hint };
    if (!isAddress(contract) || !/^\d{1,78}$/.test(String(tokenId))) return { ok: false, error: 'NFT không hợp lệ' };
    if (!/^\d{1,6}(\.\d{1,18})?$/.test(String(priceBNB)) || Number(priceBNB) <= 0) return { ok: false, error: 'Giá bán không hợp lệ' };
    const l = await buildListing(state.provider, cfg, { maker: w.address, contract, tokenId, priceBNB, days });
    const base = { priceBNB: l.priceBNB, receiveBNB: l.receiveBNB, fees: l.fees, expiresAt: l.expiresAt, days: l.days, contract, tokenId: String(tokenId) };
    const id = randomUUID();
    if (l.needsApproval) {
      const pa = previewApproveElement(cfg, w.address, contract);
      if (!pa.ok) return pa;
      state.pending.set(id, { kind: 'list-approve', maker: w.address, contract, requestId: pa.requestId, at: Date.now() });
      return { ok: true, step: 'approve', id, ...base, risks: pa.risks, needsAppApproval: pa.requireConfirmation };
    }
    const errs = checkListing(l, { maker: w.address, contract, tokenId, priceBNB, minPriceBNB: autoSellConfig().minPriceBNB });
    if (errs.length) return { ok: false, error: errs.join(' · ') };
    state.pending.set(id, { kind: 'list', maker: w.address, listing: l, contract, tokenId: String(tokenId), at: Date.now() });
    return { ok: true, step: 'list', id, ...base };
  },
  // Bước 2: bạn bấm Xác nhận. Cấp quyền (lần đầu) hoặc ký lệnh bán + gửi lên Element.
  'POST /api/list/execute': async ({ id }) => {
    const p = state.pending.get(id);
    state.pending.delete(id);
    if (!p || Date.now() - p.at > PREVIEW_TTL_MS) return { ok: false, error: 'Lệnh đã hết hạn, bấm Đăng bán lại.' };
    if (p.kind === 'list-approve') {
      const r = executeApprove(p.requestId);
      if (!r.ok) return r;
      if (!r.txHash) return { ok: true, next: 'retry', message: 'Duyệt cấp quyền trong app Binance, rồi bấm Đăng bán lại.' };
      log(`[bán] cấp quyền Element cho ${p.contract}: ${r.txHash}`);
      const done = await waitReceipt(state.provider, r.txHash);
      return done ? { ok: true, next: 'list' } : { ok: false, error: 'Cấp quyền chưa được xác nhận trên chain, thử lại sau ít phút.' };
    }
    if (p.kind !== 'list') return { ok: false, error: 'Sai loại lệnh' };
    const sig = await signListing(cfg, p.maker, p.listing.typedData);
    const posted = await postListing(cfg, p.listing.typedData, sig);
    markListed(`${p.contract.toLowerCase()}:${p.tokenId}`, { priceBNB: p.listing.priceBNB, receiveBNB: p.listing.receiveBNB, orderId: posted.orderId, expiresAt: p.listing.expiresAt });
    log(`[bán] đã đăng ${p.contract} #${p.tokenId} giá ${p.listing.priceBNB} BNB trên Element`);
    return { ok: true, ...posted };
  },
  'GET /api/wallet': () => ({ ...walletInfo(), login: state.login, install: state.install }),
  // Số dư: lấy từ baw (có giá USD), nếu lỗi thì đọc số dư BNB trực tiếp trên chain.
  'GET /api/balance': async () => {
    const w = walletInfo();
    if (!w.connected) return { ok: false, error: 'Chưa đăng nhập ví' };
    let tokens = [];
    try {
      const r = wallet.balance(cfg.binanceChainId);
      if (r.success) tokens = (r.data ?? []).map((t) => ({ symbol: t.symbol, address: t.address, balance: t.balance, valueUsd: Number(t.value) || 0 }));
    } catch {}
    if (!tokens.some((t) => t.symbol === 'BNB')) {
      const wei = await state.provider.getBalance(w.address).catch(() => null);
      if (wei !== null) tokens.unshift({ symbol: 'BNB', balance: formatEther(wei), valueUsd: state.price?.price ? Number(formatEther(wei)) * state.price.price : null });
    }
    tokens.sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0));
    return { ok: true, address: w.address, tokens, totalUsd: tokens.reduce((s, t) => s + (t.valueUsd ?? 0), 0) };
  },
  'POST /api/baw/install': () => startInstall(),
  'POST /api/login': () => startLogin(),
  'POST /api/logout': () => { state.login = null; return wallet.signout(); },
  // Chế độ "Chờ mở mint": gọi thử mint (eth_call, không gửi gì) để biết mint đã mở với ví này chưa.
  'POST /api/probe': async ({ address }) => {
    const w = walletInfo();
    if (!w.connected) return { open: false, error: w.hint };
    const key = `${address}`.toLowerCase();
    let c = state.infoCache.get(key);
    if (!c || Date.now() - c.at > 120_000) {
      c = { at: Date.now(), info: await inspectContract(state.provider, address, cfg, w.address) };
      state.infoCache.set(key, c);
    }
    const fn = c.info.mintCandidates?.[0];
    if (!fn) return { open: false, error: 'Không tìm thấy hàm mint' };
    const { data } = buildCall({ fn, walletAddr: w.address, qty: 1n });
    const r = await probeValue(state.provider, { from: w.address, to: address, data, candidates: [0n, c.info.walletPrice, c.info.price?.wei] });
    return r.ok ? { open: true, valueBNB: formatEther(r.valueWei) } : { open: false, error: r.error, startAt: c.info.startAt };
  },
  // Quyền token đã cấp (approve / permit2) và thu hồi.
  'GET /api/approvals': () => {
    const r = wallet.approvalsList(cfg.binanceChainId);
    if (!r.success) return { ok: false, error: r.error?.message ?? 'Không đọc được danh sách' };
    return { ok: true, list: r.data?.list ?? [], total: r.data?.total };
  },
  'POST /api/revoke': ({ tokenContract, spender, type }) => {
    if (!isAddress(tokenContract) || !isAddress(spender) || !['approve', 'permit2'].includes(type)) return { ok: false, error: 'Tham số không hợp lệ' };
    const r = wallet.approvalsRevoke({ chainId: cfg.binanceChainId, tokenContract, spender, type });
    if (!r.success) return { ok: false, error: r.error?.message ?? JSON.stringify(r.error) };
    log(`[revoke] ${tokenContract} → ${spender}: ${r.data?.status} ${r.data?.txHash ?? ''}`);
    return { ok: true, ...r.data };
  },
  'POST /api/scan': () => { runScan(); return { started: true }; },
  // Luật dự án từ trang web (dịch sang tiếng Việt). Chậm vài giây nên chỉ tải khi bạn mở mục Luật.
  // Dịch chữ trên giao diện (chọn English / 中文). Chỉ nhận chữ ngắn, tối đa 40 đoạn mỗi lần.
  'POST /api/translate': async ({ texts = [], lang }) => {
    const tl = { en: 'en', zh: 'zh-CN' }[lang];
    if (!tl || !Array.isArray(texts)) return { ok: false, error: 'bad request' };
    const list = texts.slice(0, 40).map((t) => String(t).slice(0, 600));
    return { ok: true, out: await translateTo(list, tl) };
  },
  'POST /api/rules': async ({ address }) => {
    if (!isAddress(address)) return { ok: false, error: 'Địa chỉ không hợp lệ' };
    const info = await inspectContract(state.provider, address, cfg).catch(() => ({}));
    return { ok: true, ...(await webRules(state.provider, address, info)) };
  },
  // RPC riêng: thử trước, chạy được mới lưu vào data/rpc.json và chuyển sang dùng ngay. Để trống = về RPC công khai.
  'POST /api/rpc': async ({ url }) => {
    url = String(url ?? '').trim();
    if (url) {
      const t = await testRpc(url);
      if (!t.ok) return t;
      mkdirSync('data', { recursive: true });
      writeFileSync('data/rpc.json', JSON.stringify({ url }));
    } else rmSync('data/rpc.json', { force: true });
    cfg.rpcUrl = url;
    state.provider = await connect(cfg, log);
    runScan();
    return { ok: true, rpc: state.provider.url, logs: state.provider.logsUrl, custom: Boolean(url) };
  },
  // Agent ID (.ai) của bạn, cho dự án mint theo Agent ID. Kiểm tra đúng chủ rồi mới lưu.
  'GET /api/agent': async () => {
    const w = walletInfo();
    const r = await resolveAgentId(state.provider, w.connected ? w.address : null).catch(() => null);
    return { ok: true, agent: r && { ...r, tokenId: r.tokenId.toString() } };
  },
  'POST /api/agent': async ({ name }) => {
    const label = labelOf(name);
    if (!label) { saveAgentName(null); return { ok: true, agent: null }; }
    if (!validLabel(label)) return { ok: false, error: 'Tên Agent ID không hợp lệ' };
    const w = walletInfo();
    const r = await resolveAgentId(state.provider, w.connected ? w.address : null, label);
    if (!r.owner) return { ok: false, error: `Không tìm thấy ${label}.ai trên sổ Agent ID` };
    if (w.connected && !r.ok) return { ok: false, error: `${label}.ai thuộc ví ${r.owner}, không phải ví đang đăng nhập` };
    saveAgentName(label);
    return { ok: true, agent: { ...r, tokenId: r.tokenId.toString() } };
  },
  // Số đã mint theo thời gian thực cho các thẻ đang hiện (giao diện hỏi 10 giây một lần).
  'POST /api/live': async ({ items = [] }) => {
    const rows = await Promise.all(items.slice(0, 20).filter((x) => isAddress(x?.address) && MINTED_GETTERS.includes(x?.getter)).map(async (x) => {
      const v = await tryCall(state.provider, x.address, new Interface([`function ${x.getter}() view returns (uint256)`]), x.getter);
      return { address: x.address, minted: v == null ? null : v.toString() };
    }));
    return { ok: true, rows };
  },
  'POST /api/inspect': async ({ address }) => {
    const w = walletInfo();
    watchAdd(address);
    const [info, page] = await Promise.all([
      inspectContract(state.provider, address, cfg, w.connected ? w.address : undefined),
      Promise.race([projectPage(state.provider, address).catch(() => null), new Promise((r) => setTimeout(() => r(null), 8000))]),
    ]);
    if (info.maxPerWallet == null && page?.perWallet) Object.assign(info, { maxPerWallet: BigInt(page.perWallet), perWalletFrom: 'site' });
    const sum = { address, ...summarize(info, cfg, { bnbUsdt: state.price?.price }), projectX: page?.x ?? null };
    // Trùng tên với NFT trong danh sách hot: cảnh báo hàng nhái.
    const twin = (state.scan?.nfts ?? []).filter((x) => x.address.toLowerCase() !== String(address).toLowerCase());
    return markLookalikes([sum, ...twin.map((x) => ({ ...x }))])[0];
  },
  // Bước 1: bấm Mint N → mô phỏng + preview Binance, trả về tóm tắt để bạn xác nhận.
  // Mint trả bằng stablecoin mà chưa approve: trả về bước approve (đúng số tiền) trước.
  // adv (Mint nâng cao): bạn tự chọn hàm, tham số, số BNB gửi kèm. Vẫn qua đủ các lớp chặn như mint thường.
  'POST /api/preview': async ({ address, qty, acceptRisk, adv }) => {
    const w = walletInfo();
    if (!w.connected) return { ok: false, error: w.hint };
    if (!isAddress(address)) return { ok: false, error: 'Địa chỉ hợp đồng không hợp lệ' };
    let manual = {};
    if (adv) {
      const err = checkAdv(adv);
      if (err) return { ok: false, error: err };
      manual = { fn: adv.fn, args: adv.args?.length ? adv.args : undefined, valueBnb: adv.valueBnb === '' || adv.valueBnb == null ? undefined : String(adv.valueBnb) };
    }
    const prep = await prepareMint(state.provider, cfg, address, { qty: Number(qty), walletAddr: w.address, bnbUsdt: state.price?.price, acceptRisk: Boolean(acceptRisk), ...manual });
    if (prep.errs.length) return { ok: false, error: prep.errs.join(' · '), notes: prep.notes };
    const cost = prep.tokenCost
      ? { amount: formatUnits(prep.tokenCost.amount, prep.tokenCost.decimals), symbol: prep.tokenCost.symbol }
      : { amount: formatEther(prep.valueWei), symbol: 'BNB' };
    const base = { qty: prep.qty.toString(), cost, costBNB: prep.costBNB, fn: prep.fn, contract: prep.target, notes: prep.notes };

    if (prep.needsApprove) {
      const pa = previewApprove(cfg, prep, w.address);
      if (!pa.ok) return pa;
      const id = randomUUID();
      state.pending.set(id, { kind: 'approve', prep, requestId: pa.requestId, at: Date.now() });
      return { ok: true, step: 'approve', id, ...base, risks: pa.risks, needsAppApproval: pa.requireConfirmation };
    }
    const pv = previewMint(cfg, prep, w.address);
    if (!pv.ok) return pv;
    const id = randomUUID();
    state.pending.set(id, { kind: 'mint', prep, requestId: pv.requestId, at: Date.now() });
    return { ok: true, step: 'mint', id, ...base, risks: pv.risks, needsAppApproval: pv.requireConfirmation };
  },
  // Bước 2: bạn bấm "Xác nhận" trong hộp thoại.
  'POST /api/execute': async ({ id }) => {
    if (/^(list|mk-)/.test(String(state.pending.get(id)?.kind))) return { ok: false, error: 'Sai loại lệnh' };
    const p = state.pending.get(id);
    state.pending.delete(id);
    if (!p || Date.now() - p.at > PREVIEW_TTL_MS) return { ok: false, error: 'Preview đã hết hạn, bấm Mint lại.' };
    if (p.kind === 'approve') {
      const r = executeApprove(p.requestId);
      if (!r.ok) return r;
      if (!r.txHash) return { ok: true, status: r.status, next: 'retry', message: 'Duyệt approve trong app Binance, rồi bấm Mint lại.' };
      log(`[approve] ${p.prep.needsApprove.symbol} cho ${p.prep.target}: ${r.txHash}`);
      const done = await waitReceipt(state.provider, r.txHash);
      return done ? { ok: true, next: 'mint' } : { ok: false, error: 'Approve chưa được xác nhận trên chain, thử lại sau ít phút.' };
    }
    const r = executeMint(p.prep, p.requestId);
    log(r.ok ? `[mint] ${p.prep.target} x${p.prep.qty}: ${r.status} ${r.txHash ?? ''}` : `[mint] lỗi: ${r.error}`);
    // Chờ giao dịch vào block để báo thành công/thất bại thật (và để lần mint sau dò đúng giá).
    if (r.ok && r.txHash) {
      r.confirmed = await waitReceipt(state.provider, r.txHash, { timeoutMs: 60_000 });
      log(`[mint] ${r.txHash}: ${r.confirmed === true ? 'thành công' : r.confirmed === false ? 'THẤT BẠI (revert)' : 'chưa xác nhận sau 60 giây'}`);
    }
    return r;
  },
};

const server = http.createServer(async (req, res) => {
  const send = (code, body, type = 'application/json') => {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(type === 'application/json' ? JSON.stringify(body, big) : body);
  };
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) return send(200, html, 'text/html; charset=utf-8');
  const handler = api[`${req.method} ${req.url}`];
  if (!handler) return send(404, { error: 'not found' });
  if (req.method === 'POST' && !ORIGINS.includes(req.headers.origin)) return send(403, { error: 'origin bị chặn' });
  try {
    let body = {};
    if (req.method === 'POST') {
      let raw = '';
      for await (const c of req) raw += c;
      body = raw ? JSON.parse(raw) : {};
    }
    send(200, await handler(body));
  } catch (e) {
    send(500, { ok: false, error: e.shortMessage || e.message });
  }
});

function openBrowser(url) {
  if (process.env.NO_OPEN) return;
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch {}
}

state.provider = await connect(cfg, log);
const refreshPrice = async () => { state.price = await bnbUsdt(state.provider).catch(() => state.price); };
await refreshPrice();
setInterval(refreshPrice, 60_000);
server.listen(PORT, '127.0.0.1', () => {
  const url = ORIGINS[0];
  log(`Mở ${url} trong trình duyệt`);
  openBrowser(url);
  runScan();
  setInterval(() => { if (state.nextScanAt && Date.now() >= state.nextScanAt) runScan(); }, 5000);
  setInterval(runAutoSell, 5000);
});
