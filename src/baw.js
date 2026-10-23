// Wrapper cho CLI `baw` (npm @binance/agentic-wallet). Bot không bao giờ chạm private key:
// ví được ký bên Binance, bạn đăng nhập bằng QR.
import { spawnSync, spawn } from 'node:child_process';

export const BAW_PACKAGE = '@binance/agentic-wallet@1.11.0'; // requiredCliVersion của skill v1.13.0
const WIN = process.platform === 'win32';
const SAFE_ARG = /^[\w.:@/=+,-]*$/; // địa chỉ, hex, id, tên lệnh: không có ký tự shell (& | < > ^ % " ! khoảng trắng)

// Trên Windows, npm cài lệnh dạng baw.cmd, phải chạy qua shell.
function cmd(bin, args) {
  for (const a of args) if (!SAFE_ARG.test(a)) throw new Error(`Tham số không hợp lệ: ${a}`);
  return WIN ? { file: `${bin}.cmd`, args, opts: { shell: true } } : { file: bin, args, opts: {} };
}

const bawBin = () => process.env.BAW_BIN || 'baw';

function parse(stdout, stderr) {
  try {
    return JSON.parse(stdout);
  } catch {
    // Có bản in thêm dòng log trước JSON: lấy khối JSON cuối cùng.
    const i = stdout.lastIndexOf('\n{');
    if (i >= 0) try { return JSON.parse(stdout.slice(i + 1)); } catch {}
    throw new Error(`baw trả về không phải JSON: ${(stdout || stderr).slice(0, 300)}`);
  }
}

export function baw(args) {
  const c = process.env.BAW_BIN ? { file: process.env.BAW_BIN, args, opts: {} } : cmd(bawBin(), args);
  const r = spawnSync(c.file, [...c.args, '--json'], { encoding: 'utf8', ...c.opts });
  const notFound = r.error?.code === 'ENOENT' || (WIN && /is not recognized|không được nhận dạng/i.test(r.stderr ?? ''));
  if (notFound) throw Object.assign(new Error('Chưa cài baw (CLI ví Binance). Bấm "Cài baw" trên giao diện.'), { code: 'BAW_MISSING' });
  if (r.error) throw new Error(`Không chạy được baw: ${r.error.message}`);
  return parse(r.stdout, r.stderr);
}

// Bản chạy nền (cho lệnh chờ lâu như auth verify).
export function bawAsync(args) {
  const c = process.env.BAW_BIN ? { file: process.env.BAW_BIN, args, opts: {} } : cmd(bawBin(), args);
  return new Promise((resolve, reject) => {
    const p = spawn(c.file, [...c.args, '--json'], c.opts);
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', () => { try { resolve(parse(out, err)); } catch (e) { reject(e); } });
  });
}

export function isInstalled() {
  try {
    baw(['wallet', 'status']);
    return true;
  } catch (e) {
    return e.code !== 'BAW_MISSING';
  }
}

export function install(onLine = () => {}) {
  const c = cmd('npm', ['i', '-g', BAW_PACKAGE]);
  return new Promise((resolve) => {
    const p = spawn(c.file, c.args, c.opts);
    const feed = (d) => String(d).split(/\r?\n/).filter(Boolean).forEach(onLine);
    p.stdout.on('data', feed);
    p.stderr.on('data', feed);
    p.on('error', (e) => resolve({ ok: false, error: e.message }));
    p.on('close', (code) => resolve(code === 0 ? { ok: true } : { ok: false, error: `npm thoát với mã ${code}` }));
  });
}

export function walletStatus() {
  return baw(['wallet', 'status']).data?.status;
}

export function bscAddress(chainId = '56') {
  const res = baw(['wallet', 'address']);
  const row = res.data?.addresses?.find((a) => String(a.binanceChainId) === String(chainId));
  return row?.address ?? null;
}

export function devModeEnabled() {
  return Boolean(baw(['wallet', 'settings']).data?.devMode?.enabled);
}

// Bản CLI khác nhau có/không có tuỳ chọn --binanceChainId: thử có trước, báo "unknown option" thì chạy lại không có.
function withChainFallback(base, chainId) {
  try {
    return baw([...base, '--binanceChainId', String(chainId)]);
  } catch (e) {
    if (/unknown option|unknown argument/i.test(e.message)) return baw(base);
    throw e;
  }
}

export const balance = (chainId = '56') => withChainFallback(['wallet', 'balance'], chainId);
export const signin = () => baw(['auth', 'signin']);
export const verify = (qrCodeId) => bawAsync(['auth', 'verify', '--qrCodeId', qrCodeId]);
export const signout = () => baw(['auth', 'signout']);

export function previewCall({ chainId, from, to, valueWei, data }) {
  return baw(['contract-call', 'preview', '--binanceChainId', String(chainId), '--from', from, '--to', to, '--value', valueWei.toString(), '--inputData', data]);
}

export function executeCall(requestId) {
  return baw(['contract-call', 'execute', '--requestId', requestId]);
}

// `approvals list` không nhận --binanceChainId: lấy hết rồi tự lọc theo chain.
export function approvalsList(chainId = '56') {
  const r = withChainFallback(['approvals', 'list'], chainId);
  const onChain = (x) => x?.binanceChainId == null || String(x.binanceChainId) === String(chainId);
  if (Array.isArray(r?.data)) r.data = r.data.filter(onChain);
  for (const k of ['list', 'approvals']) if (Array.isArray(r?.data?.[k])) r.data[k] = r.data[k].filter(onChain);
  return r;
}

export function approvalsRevoke({ chainId = '56', tokenContract, spender, type }) {
  return baw(['approvals', 'revoke', '--binanceChainId', String(chainId), '--tokenContract', tokenContract, '--spender', spender, '--type', type]);
}
