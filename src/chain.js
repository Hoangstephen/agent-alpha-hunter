import { JsonRpcProvider, id, zeroPadValue, ZeroAddress, getAddress, Interface } from 'ethers';

export const TOPIC = {
  TRANSFER: id('Transfer(address,address,uint256)'),
  TRANSFER_SINGLE: id('TransferSingle(address,address,address,uint256,uint256)'),
  ZERO: zeroPadValue(ZeroAddress, 32),
};

export const erc721 = new Interface([
  'function balanceOf(address) view returns (uint256)',
  'function supportsInterface(bytes4) view returns (bool)',
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function totalSupply() view returns (uint256)',
  'function maxSupply() view returns (uint256)',
  'function MAX_SUPPLY() view returns (uint256)',
  'function owner() view returns (address)',
  'function paused() view returns (bool)',
  'function tokenOfOwnerByIndex(address,uint256) view returns (uint256)',
]);

// RPC BSC công khai, miễn phí. Bot tự thử lần lượt, dùng cái nào chạy được (kể cả eth_getLogs).
export const PUBLIC_RPCS = [
  'https://bsc-rpc.publicnode.com',
  'https://bsc.drpc.org',
  'https://1rpc.io/bnb',
  'https://bsc.meowrpc.com',
  'https://binance.llamarpc.com',
  'https://rpc.ankr.com/bsc',
  'https://bsc-dataseed.bnbchain.org',
  'https://bsc-dataseed1.defibit.io',
];
// bsc-dataseed* của BNB Chain không hỗ trợ eth_getLogs (hoặc trả lỗi liên tục): chỉ dùng để đọc/gọi hợp đồng.
const NO_LOGS = /bsc-dataseed/i;

// Lỗi do RPC (mạng, giới hạn, quá tải) thì đổi RPC; lỗi do hợp đồng revert thì không.
// Lỗi "đoạn block quá lớn / quá nhiều log": đổi RPC không giúp được, phải chia nhỏ đoạn quét.
export function isRangeError(e) {
  const m = `${e?.message} ${e?.shortMessage} ${JSON.stringify(e?.error ?? e?.info ?? '')}`;
  return !/rate/i.test(m) && /block range|range (is )?too|too many (logs|results|blocks)|query returned more|more than \d+ (logs|results|blocks)|response size|limit exceeded|exceed(s|ed)? (the )?(max|limit)|10000|400 bad request|bad request/i.test(m);
}

export function isRpcError(e) {
  if (e?.code === 'CALL_EXCEPTION' || e?.code === 'INVALID_ARGUMENT') return false;
  return /timeout|ECONN|ENOTFOUND|EAI_AGAIN|fetch failed|rate|limit|too many|exceed|range|unavailable|bad response|SERVER_ERROR|NETWORK_ERROR|429|403|503|502|socket/i.test(`${e?.code} ${e?.message} ${e?.shortMessage}`);
}

// Nhiều RPC phía sau một giao diện giống ethers Provider.
// eth_getLogs được chạy trên danh sách RPC riêng (chỉ những RPC đã thử getLogs thành công),
// vì nhiều RPC công khai đọc hợp đồng bình thường nhưng từ chối hoặc treo khi lấy log.
export class MultiRpc {
  constructor(urls, { factory = (u) => new JsonRpcProvider(u, 56, { staticNetwork: true, batchMaxCount: 1 }), log = () => {}, custom = null } = {}) {
    this.urls = [...urls];
    this.custom = custom; // RPC riêng của bạn: luôn được ưu tiên, không bao giờ bị loại
    this.fails = new Map();
    this.factory = factory;
    this.log = log;
    this.i = 0;
    this.p = this.factory(this.urls[0]);
    this.logUrls = this.urls.filter((u) => !NO_LOGS.test(u));
    if (!this.logUrls.length) this.logUrls = [...this.urls];
    this.li = 0;
    this.lp = this.factory(this.logUrls[0]); this.lpUrl = this.logUrls[this.li];
    this.timeoutMs = 15_000;
    this.customDownAt = 0; // lúc RPC riêng lỗi gần nhất: dùng tạm RPC công khai 60 giây rồi quay lại
  }

  // RPC riêng luôn là RPC chính. Lỗi thì đổi tạm sang RPC công khai, hết 60 giây quay lại RPC riêng.
  backToCustom() {
    if (!this.custom || Date.now() - this.customDownAt < 60_000) return;
    if (this.url !== this.custom && this.urls.includes(this.custom)) {
      this.i = this.urls.indexOf(this.custom); this.p = this.factory(this.custom);
      this.log(`[rpc] quay lại RPC riêng ${hostOf(this.custom)}`);
    }
    if (this.logsUrl !== this.custom && this.logUrls.includes(this.custom)) {
      this.li = this.logUrls.indexOf(this.custom); this.lp = this.factory(this.custom); this.lpUrl = this.custom;
    }
  }

  markDown(u, e) {
    if (u !== this.custom) return;
    if (Date.now() - this.customDownAt > 60_000) this.log(`[rpc] RPC riêng ${hostOf(u)} lỗi (${errText(e)}), dùng tạm RPC công khai 60 giây${/429|limit|quota|exceed|compute unit|CU/i.test(errText(e)) ? '. Có thể đã hết hạn mức gói NodeReal: xem trang NodeReal' : ''}`);
    this.customDownAt = Date.now();
  }

  get url() { return this.urls[this.i]; }
  get logsUrl() { return this.lpUrl ?? this.logUrls[this.li]; }

  rotate(e) {
    if (this.urls.length === 1) return;
    this.i = (this.i + 1) % this.urls.length;
    this.p = this.factory(this.urls[this.i]);
    this.log(`[rpc] chuyển sang ${hostOf(this.url)}${e ? ` (lỗi trước: ${errText(e)})` : ''}`);
  }

  rotateLogs() {
    if (this.logUrls.length === 1) return;
    this.li = (this.li + 1) % this.logUrls.length;
    this.lp = this.factory(this.logUrls[this.li]); this.lpUrl = this.logUrls[this.li];
    this.log(`[rpc] lấy log qua ${hostOf(this.logsUrl)}`);
  }

  async run(fn) {
    let last;
    const seen = new Map();
    this.backToCustom();
    for (let n = 0; n < this.urls.length; n++) {
      const u = this.url;
      const p = this.p;
      try {
        // RPC công khai đôi khi treo: quá 15 giây coi như lỗi mạng và đổi RPC.
        return await withTimeout(fn(p), this.timeoutMs);
      } catch (e) {
        if (!isRpcError(e) || isRangeError(e)) throw e;
        last = e;
        // Cùng 1 lỗi ở 2 RPC khác nhau (không phải hết giờ/mạng): lỗi do lệnh gọi, đổi RPC không giúp, dừng luôn.
        const k = errText(e);
        if (!/timeout|ECONN|ENOTFOUND|EAI_AGAIN|fetch failed|429|503|502|socket/i.test(k) && (seen.get(k) ?? 0) >= 1) throw e;
        seen.set(k, (seen.get(k) ?? 0) + 1);
        this.markDown(u, e);
        if (this.p === p) this.rotate(e); // nhiều lệnh song song cùng lỗi: chỉ đổi 1 lần
      }
    }
    throw last;
  }

  // Thử tối đa 4 RPC lấy log; lỗi "đoạn quá lớn" ném ra để người gọi chia nhỏ, lỗi khác thì đổi RPC.
  // Nhiều đoạn chạy song song cùng lỗi: chỉ đổi RPC 1 lần (không đổi lòng vòng).
  // RPC không tồn tại (ENOTFOUND) hoặc lỗi 5 lần liền: loại khỏi danh sách lấy log.
  async getLogs(f) {
    let last;
    this.backToCustom();
    const tries = Math.min(4, this.logUrls.length);
    for (let n = 0; n < tries; n++) {
      const p = this.lp;
      const u = this.logsUrl;
      try {
        const r = await withTimeout(p.getLogs(f), this.timeoutMs);
        this.fails.set(u, 0);
        return r;
      } catch (e) {
        if (isRangeError(e)) throw e;
        last = e;
        this.markDown(u, e);
        const k = (this.fails.get(u) ?? 0) + 1;
        this.fails.set(u, k);
        if ((k >= 5 || /ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(`${e.message} ${e.code}`)) && u !== this.custom && this.logUrls.length > 1 && this.logUrls.includes(u)) {
          const at = this.logUrls.indexOf(u);
          this.logUrls = this.logUrls.filter((x) => x !== u);
          this.log(`[rpc] bỏ ${hostOf(u)} khỏi danh sách lấy log (lỗi: ${(e.shortMessage || e.message || '').slice(0, 60)})`);
          // RPC kế tiếp (đứng sau RPC vừa bỏ), không quay về đầu danh sách.
          if (this.lp === p) { this.li = at % this.logUrls.length; this.lp = this.factory(this.logUrls[this.li]); this.lpUrl = this.logUrls[this.li]; this.log(`[rpc] lấy log qua ${hostOf(this.logsUrl)}`); }
          else this.li = Math.max(0, this.logUrls.indexOf(this.lpUrl));
          continue;
        }
        if (this.lp === p) {
          this.logOnce(`lấy log lỗi ở ${hostOf(u)}: ${errText(e)}`);
          // Chỉ còn 1 RPC lấy log mà nó lỗi liên tục: dò lại cả danh sách tìm RPC khác lấy log được.
          if (this.logUrls.length === 1 || k >= 3) this.reprobeLogs();
          this.rotateLogs();
        }
      }
    }
    throw last;
  }

  // Cùng 1 thông báo chỉ in 1 lần mỗi 30 giây (tránh nhật ký đầy dòng lặp lại).
  logOnce(m) {
    this.said ??= new Map();
    if (Date.now() - (this.said.get(m) ?? 0) < 30_000) return;
    this.said.set(m, Date.now());
    this.log(`[rpc] ${m}`);
  }

  // Dò lại mọi RPC (kể cả RPC riêng) xem cái nào lấy log được, tối đa 1 lần mỗi 2 phút, chạy nền.
  reprobeLogs() {
    if (this.reprobing || Date.now() - (this.reprobedAt ?? 0) < 120_000) return;
    this.reprobing = true;
    this.reprobedAt = Date.now();
    const all = [...new Set([...(this.custom ? [this.custom] : []), ...this.urls])].filter((u) => !NO_LOGS.test(u));
    Promise.allSettled(all.map(async (u) => {
      const p = this.factory(u);
      const t0 = Date.now();
      const head = await withTimeout(p.getBlockNumber(), 6000);
      await withTimeout(p.getLogs({ fromBlock: head - 2000, toBlock: head, topics: [TOPIC.TRANSFER, null, TOPIC.ZERO] }), 8000);
      return { u, ms: Date.now() - t0 };
    })).then((rs) => {
      const ok = rs.filter((r) => r.status === 'fulfilled').map((r) => r.value).sort((a, b) => (a.u === this.custom ? -1 : b.u === this.custom ? 1 : a.ms - b.ms));
      if (!ok.length) return this.logOnce('dò lại: chưa RPC nào lấy log được, nên dùng RPC riêng (NodeReal)');
      this.logUrls = ok.map((r) => r.u);
      this.fails.clear();
      this.li = 0; this.lpUrl = this.logUrls[0]; this.lp = this.factory(this.lpUrl);
      this.log(`[rpc] dò lại xong: lấy log qua ${hostOf(this.lpUrl)} (${ok.length} RPC lấy log được)`);
    }).finally(() => { this.reprobing = false; });
  }

  // Thử mọi RPC cùng lúc. Đọc hợp đồng: RPC trả blockNumber nhanh nhất.
  // Lấy log: chỉ RPC trả được cả log toàn mạng (50 block) lẫn log lọc theo ví (2000 block), xếp theo tốc độ.
  async init() {
    const probe = async (u) => {
      const p = this.factory(u);
      const t0 = Date.now();
      const head = await withTimeout(p.getBlockNumber(), 6000);
      const readMs = Date.now() - t0;
      let logsMs = null;
      if (!NO_LOGS.test(u)) {
        try {
          await withTimeout(p.getLogs({ fromBlock: head - 50, toBlock: head, topics: [TOPIC.TRANSFER, TOPIC.ZERO] }), 8000);
          await withTimeout(p.getLogs({ fromBlock: head - 2000, toBlock: head, topics: [TOPIC.TRANSFER, null, TOPIC.ZERO] }), 8000);
          logsMs = Date.now() - t0;
        } catch {}
      }
      return { u, p, readMs, logsMs };
    };
    const res = (await Promise.allSettled(this.urls.map(probe))).filter((r) => r.status === 'fulfilled').map((r) => r.value);
    if (!res.length) throw new Error('Không RPC công khai nào trả lời. Kiểm tra mạng, hoặc đặt BSC_RPC_URL.');
    // RPC riêng của bạn (BSC_RPC_URL, đứng đầu danh sách) luôn được ưu tiên nếu chạy được.
    const rank = (a, b, k) => (a.u === this.urls[0] ? -1 : b.u === this.urls[0] ? 1 : a[k] - b[k]);
    const read = [...res].sort((a, b) => rank(a, b, 'readMs'));
    this.urls = [...read.map((r) => r.u), ...this.urls.filter((u) => !read.some((r) => r.u === u))];
    const customOk = this.custom && read.some((r) => r.u === this.custom);
    if (this.custom && !customOk) {
      // RPC riêng không trả lời lúc khởi động: vẫn giữ đầu danh sách, dùng tạm RPC công khai rồi thử lại sau 60 giây.
      this.urls = [this.custom, ...this.urls.filter((u) => u !== this.custom)];
      this.i = 1 % this.urls.length;
      this.p = this.factory(this.urls[this.i]);
      this.customDownAt = Date.now();
      this.log(`[rpc] ⚠ RPC riêng ${hostOf(this.custom)} không trả lời lúc khởi động. Dùng tạm RPC công khai, 60 giây sau thử lại.`);
    } else {
      this.i = 0;
      this.p = read[0].p;
    }
    // RPC riêng đã được kiểm tra lúc lưu: giữ đầu danh sách lấy log kể cả khi lần thử này chậm.
    const logs = res.filter((r) => r.logsMs != null || (this.custom && r.u === this.custom)).sort((a, b) => rank(a, b, 'logsMs'));
    if (logs.length) {
      this.logUrls = logs.map((r) => r.u);
      if (this.custom && !this.logUrls.includes(this.custom)) this.logUrls.unshift(this.custom);
      this.li = this.custom && !customOk ? Math.min(1, this.logUrls.length - 1) : 0;
      this.lpUrl = this.logUrls[this.li];
      this.lp = logs.find((r) => r.u === this.lpUrl)?.p ?? this.factory(this.lpUrl);
    } else {
      this.log('[rpc] cảnh báo: không RPC công khai nào trả log lúc này, việc tìm NFT có thể thiếu. Nên đặt BSC_RPC_URL riêng.');
    }
    if (this.custom) this.log(`[rpc] RPC riêng: ${hostOf(this.custom)} ${customOk ? '✓ đang dùng (đọc hợp đồng + lấy log)' : '✗ chưa trả lời'}`);
    else this.log('[rpc] chưa có RPC riêng (data/rpc.json trống): đang dùng RPC công khai. Dán link NodeReal ở mục ⚙ RPC riêng.');
    this.log(`[rpc] đọc hợp đồng: ${hostOf(this.url)} · lấy log: ${hostOf(this.logsUrl)} (${logs.length} RPC lấy log được)`);
    return this;
  }

  getBlockNumber() { return this.run((p) => p.getBlockNumber()); }
  getCode(a) { return this.run((p) => p.getCode(a)); }
  getStorage(a, s) { return this.run((p) => p.getStorage(a, s)); }
  call(tx) { return this.run((p) => p.call(tx)); }
  estimateGas(tx) { return this.run((p) => p.estimateGas(tx)); }
  getBalance(a) { return this.run((p) => p.getBalance(a)); }
  getTransaction(h) { return this.run((p) => p.getTransaction(h)); }
  getTransactionReceipt(h) { return this.run((p) => p.getTransactionReceipt(h)); }
}

// Chỉ hiện tên miền RPC, không hiện phần đường dẫn (có API key).
const hostOf = (u) => { try { return new URL(u).host; } catch { return String(u); } };
const errText = (e) => String(e?.shortMessage || e?.message || e || '').replace(/https?:\/\/\S+/g, '').slice(0, 90);

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
}

// Kiểm tra 1 RPC trước khi lưu: đúng mạng BSC (chainId 56), đọc được block, lấy được log theo ví trên 2000 block.
export async function testRpc(url, factory = (u) => new JsonRpcProvider(u, 56, { staticNetwork: true, batchMaxCount: 1 })) {
  let u;
  try { u = new URL(url); } catch { return { ok: false, error: 'Link RPC không hợp lệ' }; }
  if (u.protocol !== 'https:') return { ok: false, error: 'Link RPC phải bắt đầu bằng https://' };
  const p = factory(url);
  try {
    const chainId = await withTimeout(p.send('eth_chainId', []), 8000);
    if (BigInt(chainId) !== 56n) return { ok: false, error: `RPC này không phải BNB Smart Chain (chainId ${BigInt(chainId)}, cần 56)` };
    const t0 = Date.now();
    const head = await withTimeout(p.getBlockNumber(), 8000);
    await withTimeout(p.getLogs({ fromBlock: head - 2000, toBlock: head, topics: [TOPIC.TRANSFER, null, TOPIC.ZERO] }), 15000);
    return { ok: true, head, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, error: `RPC không dùng được: ${(e.shortMessage || e.message || '').slice(0, 160)}` };
  }
}

export async function connect(cfg, log = console.log) {
  const urls = cfg.rpcUrl ? [cfg.rpcUrl, ...PUBLIC_RPCS.filter((u) => u !== cfg.rpcUrl)] : PUBLIC_RPCS;
  return new MultiRpc(urls, { log, custom: cfg.rpcUrl || null }).init();
}

// Chạy fn trên từng phần tử, tối đa `limit` việc cùng lúc, giữ nguyên thứ tự kết quả.
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// Lấy log theo từng đoạn block, chạy song song.
// - Đoạn bị RPC chê quá lớn: chia đôi, tối đa 3 lần.
// - Đoạn lỗi vì lý do khác (RPC đã được đổi rồi vẫn lỗi): bỏ qua. Lỗi nhiều liên tiếp thì dừng sớm,
//   không gửi thêm hàng trăm yêu cầu vô ích.
// - deadlineMs: hết giờ thì trả phần đã lấy được (quét mới nhất trước).
export async function getLogsChunked(provider, filter, fromBlock, toBlock, chunk, { concurrency = 4, deadlineMs = 60_000, maxFails = 6 } = {}) {
  if (typeof arguments[5] === 'number') concurrency = arguments[5];
  const ranges = [];
  for (let end = toBlock; end >= fromBlock; end -= chunk) ranges.push([Math.max(end - chunk + 1, fromBlock), end]);
  const stopAt = Date.now() + deadlineMs;
  let failed = 0, ok = 0, skipped = 0, lastErr;
  const get = async ([a, b], depth = 0) => {
    if (failed >= maxFails && failed > ok) { skipped += 1; return []; }
    if (Date.now() > stopAt) { skipped += 1; return []; }
    try {
      const r = await provider.getLogs({ ...filter, fromBlock: a, toBlock: b });
      ok += 1;
      return r;
    } catch (e) {
      lastErr = e;
      if (isRangeError(e) && depth < 3 && b > a) {
        const mid = Math.floor((a + b) / 2);
        return [...(await get([a, mid], depth + 1)), ...(await get([mid + 1, b], depth + 1))];
      }
      failed += 1;
      return [];
    }
  };
  const logs = (await mapLimit(ranges, concurrency, get)).flat();
  if (!ok && (failed || skipped)) throw new Error(`RPC không trả log (${failed} đoạn lỗi${lastErr ? `: ${(lastErr.shortMessage || lastErr.message || '').slice(0, 80)}` : ''})`);
  logs.incomplete = failed + skipped > 0;
  return logs.sort((x, y) => x.blockNumber - y.blockNumber || (x.index ?? x.logIndex ?? 0) - (y.index ?? y.logIndex ?? 0));
}

// Thử nhiều getter cùng lúc, trả về kết quả đầu tiên (theo thứ tự danh sách) không null.
export async function firstOf(promises) {
  const vals = await Promise.all(promises);
  return vals.find((v) => v !== null && v !== undefined) ?? null;
}

// eth_call an toàn: trả về null nếu revert / không có hàm.
export async function tryCall(provider, to, iface, fn, args = []) {
  try {
    const data = iface.encodeFunctionData(fn, args);
    const ret = await provider.call({ to, data });
    if (!ret || ret === '0x') return null;
    return iface.decodeFunctionResult(fn, ret)[0];
  } catch {
    return null;
  }
}

export const topicToAddress = (t) => getAddress('0x' + t.slice(26));

// Gộp nhiều lệnh đọc hợp đồng thành 1 lần gọi RPC qua Multicall3 (tiết kiệm hạn mức RPC riêng).
// reads: [{ target, iface, fn, args }] → mảng kết quả đã giải mã (giá trị đầu) hoặc null nếu lệnh đó lỗi.
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const mc3 = new Interface(['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns ((bool success,bytes returnData)[])']);
export async function multiRead(provider, reads) {
  if (!reads.length) return [];
  const calls = reads.map((r) => ({ target: r.target, allowFailure: true, callData: r.iface.encodeFunctionData(r.fn, r.args ?? []) }));
  let res;
  try { [res] = mc3.decodeFunctionResult('aggregate3', await provider.call({ to: MULTICALL3, data: mc3.encodeFunctionData('aggregate3', [calls]) })); }
  catch { return Promise.all(reads.map((r) => tryCall(provider, r.target, r.iface, r.fn, r.args ?? []))); } // chain/RPC không có Multicall3: gọi từng cái
  return res.map((x, i) => { try { return x.success ? reads[i].iface.decodeFunctionResult(reads[i].fn, x.returnData)[0] : null; } catch { return null; } });
}
