// Luồng mint: kiểm tra rủi ro → mô phỏng → preview qua baw → bạn xác nhận → execute.
// Dùng chung cho giao diện web và dòng lệnh.
// Mint trả bằng stablecoin (USDT...) có thêm bước approve ĐÚNG số tiền cho ĐÚNG hợp đồng NFT.
import { KNOWN } from './projects.js';
import { AGENT_MINT_FN } from './risk.js';
import { id, Interface, parseEther, formatEther, formatUnits, getAddress, ZeroAddress } from 'ethers';
import { createInterface } from 'node:readline/promises';
import { inspectContract, guardCall, guardApprove, probeValue } from './risk.js';
import { tryCall } from './chain.js';
import { Ledger } from './ledger.js';
import { watchAdd } from './watch.js';
import { learnMint } from './learn.js';
import * as wallet from './baw.js';

const erc20 = new Interface(['function approve(address,uint256)', 'function allowance(address,address) view returns (uint256)']);
// Giá theo bậc (lần 1 free, lần 2 0.001...): nhiều hợp đồng có hàm báo giá cho đúng ví + số lượng. Thử các tên phổ biến.
const QUOTE_NAMES = ['quote', 'getPrice', 'mintPrice', 'getMintPrice', 'priceFor', 'quoteMint', 'getCost', 'costOf', 'mintCost', 'getQuote', 'priceOf', 'totalPrice', 'calculatePrice', 'getMintCost'];
const QUOTE_SIGS = QUOTE_NAMES.flatMap((n) => [`${n}(address,uint256)`, `${n}(uint256,address)`, `${n}(uint256)`]);
export async function quotes(provider, target, walletAddr, qty) {
  const code = String(await provider.getCode(target).catch(() => '')).toLowerCase();
  const present = QUOTE_SIGS.filter((sig) => code.includes(id(sig).slice(2, 10)));
  const vals = await Promise.all(present.map((sig) => {
    const args = sig.endsWith('(address,uint256)') ? [walletAddr, qty] : sig.endsWith('(uint256,address)') ? [qty, walletAddr] : [qty];
    return tryCall(provider, target, new Interface([`function ${sig} view returns (uint256)`]), sig.split('(')[0], args).catch(() => null);
  }));
  return vals.filter((v) => v != null && v > 0n && v <= 10n ** 18n);
}
const fmtArgs = (a) => JSON.stringify(a, (_, v) => (typeof v === 'bigint' ? v.toString() : v));

export function buildCall({ fn, args, walletAddr, qty = 1n }) {
  const iface = new Interface([`function ${fn} payable`]);
  const frag = iface.fragments[0];
  let a = args;
  if (!a) {
    // Mẫu mint phổ biến: tham số uint cuối = số lượng, address = ví của bạn.
    a = frag.inputs.map((p) => (p.type === 'address' ? walletAddr : p.type.startsWith('uint') ? 1n : null));
    if (a.some((x) => x === null)) throw new Error(`Hàm ${fn} cần tham số đặc biệt (proof/chữ ký...). Mint qua web dự án.`);
    const last = frag.inputs.length - 1;
    if (last >= 0 && frag.inputs[last].type.startsWith('uint')) a[last] = BigInt(qty);
    else if (BigInt(qty) !== 1n) throw new Error(`Hàm ${fn} không có tham số số lượng: chỉ mint được 1 mỗi lần.`);
  }
  const takesQty = frag.inputs.length && frag.inputs.at(-1).type.startsWith('uint');
  return { data: iface.encodeFunctionData(frag, a), args: a, qty: takesQty ? BigInt(a.at(-1)) : 1n };
}

// Giá 1 NFT quy ra BNB (số thực). Giá trả bằng stablecoin thì đổi theo tỉ giá BNB/USDT.
export function unitCostBNB(info, bnbUsdt) {
  if (!info.price) return null;
  if (info.payToken) {
    const usd = Number(formatUnits(info.price.wei, info.payToken.decimals));
    return bnbUsdt ? usd / bnbUsdt : null;
  }
  return Number(formatEther(info.price.wei));
}

// Số lượng tối đa mint được lúc này, theo luật của dự án và trần chi tiêu của bạn.
export function maxQty(info, cfg, { bnbUsdt } = {}) {
  const lim = [];
  const add = (v, why) => { if (v != null) lim.push({ v: BigInt(v), why }); };
  add(cfg.limits.defaultMaxQty ?? 20, 'mặc định');
  if (info.maxPerWallet != null) add(info.maxPerWallet - (info.walletMinted ?? 0n), info.walletMinted ? `giới hạn ví (đã có ${info.walletMinted})` : 'giới hạn mỗi ví');
  if (info.maxPerTx != null) add(info.maxPerTx, 'giới hạn mỗi giao dịch');
  if (info.maxSupply && info.totalSupply != null) add(info.maxSupply - info.totalSupply, 'số còn lại');
  const unit = unitCostBNB(info, bnbUsdt);
  if (unit > 0) add(Math.floor(cfg.limits.maxPerMintBNB / unit + 1e-9), 'trần chi tiêu mỗi lần');
  // Có giới hạn của dự án thì bỏ mức mặc định.
  const real = lim.filter((l) => l.why !== 'mặc định');
  const pool = info.maxPerWallet != null || info.maxPerTx != null ? real : lim;
  const best = pool.reduce((a, b) => (b.v < a.v ? b : a));
  return { max: Number(best.v < 0n ? 0n : best.v), limitedBy: best.why };
}

// Điểm thấp nhất được phép khi bạn tick "đã tự kiểm tra hợp đồng". Dưới mức này luôn chặn.
export const HARD_MIN_SCORE = 40;

export async function prepareMint(provider, cfg, address, { qty = 1, fn, args, valueBnb, walletAddr, info, bnbUsdt, acceptRisk = false } = {}) {
  const target = getAddress(address);
  info ??= await inspectContract(provider, target, cfg, walletAddr);
  const out = { target, info, errs: [], notes: [] };
  const minScore = acceptRisk ? Math.min(HARD_MIN_SCORE, cfg.limits.minRiskScore) : cfg.limits.minRiskScore;
  if (info.score < minScore) out.errs.push(`Điểm an toàn ${info.score}/100 dưới ngưỡng ${minScore}${acceptRisk ? '' : ' (tick "Tôi đã tự kiểm tra hợp đồng" nếu điểm từ ' + HARD_MIN_SCORE + ' trở lên)'}`);
  if (info.hasAgentId === false) out.notes.push('Ví này chưa có Agent ID (.ai): dự án chỉ cho ví có Agent ID mint thì sẽ bị từ chối.');
  if (info.paused === true) out.errs.push('Hợp đồng đang tạm dừng (paused)');
  if ((KNOWN[target.toLowerCase()]?.needsAgentId || info.usesAgentId) && info.hasAgentId === false) out.errs.push('Dự án này chỉ cho ví có Binance Agent ID (.ai) mint, ví của bạn chưa có');
  const { max, limitedBy } = maxQty(info, cfg, { bnbUsdt });
  if (Number(qty) > max) out.errs.push(`Tối đa ${max} NFT lúc này (${limitedBy})`);

  // Mint theo Agent ID: tham số = [số ID Agent ID của bạn, số lượng], giá đọc từ quote() ngay trước khi mint.
  if (info.agentMint && !fn) {
    if (!info.agent?.ok) {
      out.errs.push(info.agent?.name
        ? `Agent ID ${info.agent.name} không thuộc ví này (chủ: ${info.agent.owner ?? 'không có'}). Nhập lại tên .ai ở ô Agent ID.`
        : 'Dự án mint theo Agent ID: nhập tên .ai của bạn (vd. hoangfud.ai) ở ô "Agent ID của bạn" rồi thử lại.');
      return out;
    }
    fn = AGENT_MINT_FN;
    args = [info.agent.tokenId, String(qty)];
    out.quoteWei = await tryCall(provider, target, new Interface(['function quote(uint256,uint256) view returns (uint256)']), 'quote', [BigInt(info.agent.tokenId), BigInt(qty)]);
    if (out.quoteWei == null) { out.errs.push('Không đọc được giá quote() từ hợp đồng'); return out; }
    out.notes.push(`Mint bằng Agent ID ${info.agent.name ?? '#' + info.agent.tokenId}`);
  }
  out.fn = fn || info.mintCandidates?.[0];
  if (!out.fn) {
    out.errs.push('Không tìm thấy hàm mint công khai');
    return out;
  }
  const simFrom = walletAddr || ZeroAddress;
  // Cách mint mặc định không chạy: học từ giao dịch mint thành công của người khác.
  const learned = async (why) => {
    if (!walletAddr || fn || args || valueBnb != null || info.payToken) return false;
    const l = await learnMint(provider, target, { walletAddr, qty: BigInt(qty), candidates: info.mintCandidates ?? [] });
    if (l?.needAgentId) { out.errs.push('Người khác mint bằng Agent ID: nhập tên .ai của bạn ở ô "Agent ID của bạn" rồi thử lại.'); return true; }
    if (!l) return false;
    Object.assign(out, { data: l.data, valueWei: l.valueWei, qty: l.qty, fn: l.fn, args: null, probed: true, learned: l.sample });
    out.notes.push(`Cách mint mặc định bị từ chối (${why}). Bot chép cách mint từ giao dịch thành công của người khác${l.notes.length ? ' (' + l.notes.join(', ') + ')' : ''}.`);
    return true;
  };
  let viaLearn = false;
  try {
    Object.assign(out, buildCall({ fn: out.fn, args, walletAddr: simFrom, qty: BigInt(qty) }));
  } catch (e) {
    if (!(viaLearn = await learned(e.message))) { out.errs.push(e.message); return out; }
    if (out.errs.length) return out;
  }

  const pay = info.payToken;
  if (viaLearn) {
    // đã mô phỏng thành công với dữ liệu chép từ giao dịch mẫu
  } else if (pay && valueBnb == null) {
    out.valueWei = 0n;
    out.tokenCost = { ...pay, amount: info.price.wei * out.qty };
    out.costBNB = bnbUsdt ? Number(formatUnits(out.tokenCost.amount, pay.decimals)) / bnbUsdt : null;
    if (out.costBNB == null) out.errs.push('Chưa có tỉ giá BNB/USDT để kiểm tra trần chi tiêu');
    if (walletAddr) {
      const allowance = (await tryCall(provider, pay.address, erc20, 'allowance', [walletAddr, target])) ?? 0n;
      if (allowance < out.tokenCost.amount) {
        out.needsApprove = { token: pay.address, symbol: pay.symbol, amount: out.tokenCost.amount, data: erc20.encodeFunctionData('approve', [target, out.tokenCost.amount]) };
      }
    }
  } else if (valueBnb != null) {
    out.valueWei = parseEther(String(valueBnb));
  } else if (out.quoteWei != null) {
    // Gửi đúng giá quote (hợp đồng cho phép tối đa +1%); mô phỏng trước để chắc chắn.
    out.valueWei = out.quoteWei;
    if (walletAddr) {
      const probe = await probeValue(provider, { from: walletAddr, to: target, data: out.data, candidates: [out.quoteWei] });
      if (!probe.ok) { out.errs.push(`Hợp đồng từ chối lệnh mint lúc này (${probe.error}). Có thể đã hết suất hoặc hết lượt của Agent ID.`); return out; }
      out.probed = true;
    }
  } else if (walletAddr) {
    // Dò giá thật cho ví này: mint đầu free, lần sau trả phí... hợp đồng nào cũng trả lời đúng qua eth_call.
    const candidates = [0n, info.walletPrice, info.walletPrice != null ? info.walletPrice * out.qty : null, info.price?.wei, info.price ? info.price.wei * out.qty : null, ...(await quotes(provider, target, walletAddr, out.qty))];
    const probe = await probeValue(provider, { from: walletAddr, to: target, data: out.data, candidates });
    if (probe.ok) {
      out.valueWei = probe.valueWei;
      out.probed = true;
    } else if (await learned(probe.error)) {
      if (out.errs.length) return out;
    } else {
      out.valueWei = info.price ? info.price.wei * out.qty : 0n;
      out.errs.push(`Hợp đồng từ chối lệnh mint lúc này (${probe.error}). Có thể mint chưa mở, ví thiếu Agent ID, hoặc đã hết lượt.`);
      return out;
    }
  } else {
    out.valueWei = info.price ? info.price.wei * out.qty : 0n;
    if (!info.price) out.notes.push('Không đọc được giá on-chain, giả định miễn phí.');
  }
  if (!pay || valueBnb != null) out.costBNB = Number(formatEther(out.valueWei));

  const costWei = parseEther((out.costBNB ?? 0).toFixed(18));
  out.costWei = costWei;
  out.errs.push(...guardCall({ to: target, target, data: out.data, valueWei: costWei, maxPerMintWei: parseEther(String(cfg.limits.maxPerMintBNB)) }));
  const spent = new Ledger().spentTodayWei();
  if (spent + costWei > parseEther(String(cfg.limits.maxDailyBNB))) out.errs.push(`Vượt trần ngày: đã chi ${formatEther(spent)} BNB, trần ${cfg.limits.maxDailyBNB} BNB`);
  if (out.errs.length) return out;

  if (out.needsApprove) {
    out.notes.push(`Cần cho phép hợp đồng dùng đúng ${formatUnits(out.needsApprove.amount, pay.decimals)} ${pay.symbol} trước khi mint.`);
    return out; // chưa mô phỏng mint được khi chưa approve
  }
  try {
    out.gas = await provider.estimateGas({ from: simFrom, to: target, data: out.data, value: out.valueWei });
  } catch (e) {
    out.simError = e.shortMessage || e.message;
    // Mô phỏng từ address(0) có thể revert vì thiếu Agent ID; chỉ chặn khi đã có ví thật.
    if (walletAddr) out.errs.push(`Mô phỏng revert: ${out.simError}`);
    else out.notes.push(`Mô phỏng từ ví trống revert (${out.simError}), sẽ kiểm tra lại bằng ví của bạn.`);
  }
  return out;
}

function checkWallet() {
  let status;
  try { status = wallet.walletStatus(); } catch (e) { if (e.auth || e.code === 'BAW_MISSING') return 'Ví chưa đăng nhập. Bấm "Đăng nhập ví" rồi quét QR trong app Binance.'; status = 'CONNECTED'; } // lỗi thoáng qua: để Binance preview tự kiểm
  if (status !== 'CONNECTED') return 'Ví chưa đăng nhập. Bấm "Đăng nhập ví" rồi quét QR trong app Binance.';
  if (wallet.devModeEnabled() === false) return 'Developer Mode đang tắt. Bật trong app Binance → Agentic Wallet.';
  return null;
}

function readPreview(p) {
  const d = p.data;
  const sim = d.simulationResult ?? {};
  const risks = [
    ...(d.risks?.riskDetails ?? []).map((r) => `[${r.riskType}] ${r.title}: ${r.description}`),
    ...Object.entries(d.risks?.addresses ?? {}).flatMap(([a, v]) => (v.riskDetails ?? []).map((r) => `Địa chỉ ${a}: ${r.title}: ${r.description}`)),
  ];
  return { d, sim, risks };
}

// Bước approve (chỉ với mint trả bằng stablecoin).
export function previewApprove(cfg, prep, walletAddr) {
  const err = checkWallet();
  if (err) return { ok: false, error: err };
  const a = prep.needsApprove;
  const errs = guardApprove({ token: a.token, spender: prep.target, target: prep.target, amount: a.amount, expected: prep.tokenCost.amount });
  if (errs.length) return { ok: false, error: errs.join(' · ') };
  const p = wallet.previewCall({ chainId: cfg.binanceChainId, from: walletAddr, to: a.token, valueWei: 0n, data: a.data });
  if (!p.success) return { ok: false, error: `Binance từ chối: ${p.error?.message ?? JSON.stringify(p.error)}` };
  const { d, sim, risks } = readPreview(p);
  if ((sim.authorityChanges ?? []).length) return { ok: false, error: 'Approve này kèm thay đổi quyền khác: bị chặn.', risks };
  return { ok: true, requestId: d.requestId, risks, requireConfirmation: d.requireConfirmation };
}

// Gọi Binance mô phỏng + quét rủi ro cho lệnh mint. Chưa ký gì.
export function previewMint(cfg, prep, walletAddr) {
  const err = checkWallet();
  if (err) return { ok: false, error: err };
  const p = wallet.previewCall({ chainId: cfg.binanceChainId, from: walletAddr, to: prep.target, valueWei: prep.valueWei, data: prep.data });
  if (!p.success) return { ok: false, error: `Binance từ chối: ${p.error?.message ?? JSON.stringify(p.error)}` };
  const { d, sim, risks } = readPreview(p);
  if ((sim.allowanceChanges ?? []).length || (sim.authorityChanges ?? []).length) {
    return { ok: false, error: 'Giao dịch này cấp quyền (allowance/authority) cho bên khác. Mint thật không cần, đã chặn.', risks };
  }
  return { ok: true, requestId: d.requestId, parsedTx: d.parsedTx, balanceChanges: sim.balanceChanges ?? [], risks, requireConfirmation: d.requireConfirmation };
}

export function executeApprove(requestId) {
  const r = wallet.executeCall(requestId);
  if (!r.success) return { ok: false, error: r.error?.message ?? JSON.stringify(r.error) };
  return { ok: true, status: r.data.status, txHash: r.data.txHash };
}

export function executeMint(prep, requestId) {
  const r = wallet.executeCall(requestId);
  if (!r.success) return { ok: false, error: r.error?.message ?? JSON.stringify(r.error) };
  watchAdd(prep.target);
  new Ledger().add({ target: prep.target, fn: prep.fn, qty: prep.qty.toString(), valueWei: prep.costWei, txHash: r.data.txHash, status: r.data.status });
  return { ok: true, status: r.data.status, txHash: r.data.txHash };
}

// Chờ giao dịch được xác nhận trên chain (dùng sau bước approve).
export async function waitReceipt(provider, hash, { timeoutMs = 90_000, everyMs = 2000 } = {}) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const r = await provider.getTransactionReceipt(hash).catch(() => null);
    if (r) return r.status === 1 || r.status === '0x1';
    await new Promise((res) => setTimeout(res, everyMs));
  }
  return null;
}

// Dòng lệnh: mặc định dry-run, --preview, --live (gõ xác nhận).
export async function mint(provider, cfg, address, opts) {
  const mode = opts.live ? 'live' : opts.preview ? 'preview' : 'dry';
  let walletAddr = cfg.walletAddress;
  if (!walletAddr && mode !== 'dry') walletAddr = wallet.bscAddress(cfg.binanceChainId);

  const prep = await prepareMint(provider, cfg, address, { qty: opts.qty ?? 1, fn: opts.fn, args: opts.args && JSON.parse(opts.args), valueBnb: opts.valueBnb, walletAddr, bnbUsdt: opts.bnbUsdt, acceptRisk: Boolean(opts.acceptRisk) });
  console.log(`\n== MINT ${prep.target} | ${mode.toUpperCase()} | an toàn ${prep.info.score}/100 ==`);
  prep.info.flags.forEach((f) => console.log('  ' + f));
  prep.notes.forEach((n) => console.log('ℹ ' + n));
  if (prep.errs.length) {
    prep.errs.forEach((e) => console.log('✖ ' + e));
    return { ok: false, reason: 'blocked', errs: prep.errs };
  }
  const cost = prep.tokenCost ? `${formatUnits(prep.tokenCost.amount, prep.tokenCost.decimals)} ${prep.tokenCost.symbol}` : `${formatEther(prep.valueWei)} BNB`;
  console.log(`Hàm ${prep.fn} | args ${fmtArgs(prep.args)} | ${cost}`);

  if (mode === 'dry') {
    console.log('DRY-RUN: không gửi gì. Thêm --preview hoặc --live.');
    return { ok: true, mode, data: prep.data, valueWei: prep.valueWei };
  }
  const ask = async (q) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const a = (await rl.question(q)).trim();
    rl.close();
    return a;
  };
  const code = `MINT ${prep.target.slice(-4)}`;

  if (prep.needsApprove) {
    const pa = previewApprove(cfg, prep, walletAddr);
    if (!pa.ok) return console.log('✖ ' + pa.error), { ok: false, reason: 'approve', error: pa.error };
    if (mode === 'preview') return { ok: true, mode, approveRequestId: pa.requestId };
    if ((await ask(`Bước 1/2: cho phép hợp đồng dùng đúng ${cost}. Gõ "${code}" để đồng ý: `)) !== code) return { ok: false, reason: 'cancelled' };
    const ra = executeApprove(pa.requestId);
    if (!ra.ok || !ra.txHash) return console.log('✖ ' + (ra.error ?? 'Approve chờ duyệt trong app, chạy lại sau khi duyệt.')), { ok: false, reason: 'approve' };
    console.log('Đang chờ approve được xác nhận…');
    if (!(await waitReceipt(provider, ra.txHash))) return console.log('✖ Approve chưa xác nhận.'), { ok: false, reason: 'approve' };
    return mint(provider, cfg, address, opts); // chạy lại, lần này không cần approve
  }

  const pv = previewMint(cfg, prep, walletAddr);
  pv.risks?.forEach((r) => console.log('⚠ ' + r));
  if (!pv.ok) {
    console.log('✖ ' + pv.error);
    return { ok: false, reason: 'preview', error: pv.error };
  }
  console.log('✓ Binance preview OK', JSON.stringify(pv.parsedTx));
  if (mode === 'preview') return { ok: true, mode, requestId: pv.requestId };

  if ((await ask(`DYOR. Gõ "${code}" để mint ${prep.qty} cái, ${cost}: `)) !== code) return console.log('Đã huỷ.'), { ok: false, reason: 'cancelled' };
  const r = executeMint(prep, pv.requestId);
  console.log(r.ok ? (r.status === 'PENDING_CONFIRMATION' ? '⏳ Duyệt tiếp trong app Binance.' : `✓ https://bscscan.com/tx/${r.txHash}`) : '✖ ' + r.error);
  return { ...r, mode };
}
