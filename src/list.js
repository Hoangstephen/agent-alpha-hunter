// Đăng bán NFT trên Element ngay từ ví Agentic, không cần kết nối ví vào web Element.
// Cách làm giống SDK chính thức của Element (github.com/element-market/element-js-sdk):
//   1) Lần đầu với mỗi bộ NFT: cho sàn Element quyền chuyển NFT khi có người mua (setApprovalForAll).
//      Bot CHỈ cho phép cấp quyền này cho đúng hợp đồng sàn Element trên BSC, không cho địa chỉ nào khác.
//   2) Ký lệnh bán (chữ ký EIP-712, không tốn gas) bằng `baw sign-message`, rồi gửi lệnh lên Element.
// Trước khi ký, bot tự kiểm tra lại từng trường của lệnh: người bán là ví bạn, nhận BNB, đúng NFT, đúng giá.
import { Interface, Contract, getAddress, parseEther, formatEther, Signature, TypedDataEncoder, verifyTypedData, ZeroAddress } from 'ethers';
import * as wallet from './baw.js';

// Địa chỉ trong element-js-sdk 3.0.0 (lib/src/contracts/config.js), chain 56.
export const ELEMENT = {
  EX: '0xb3e3DfCb2d9f3DdE16d78B9e6EB3538Eb32B5ae1',
  HELPER: '0xb54ee46dACE4ecAC1dBC2488B61094B4b3174139',
  API: 'https://api.element.market',
};
const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'; // BNB trong lệnh Element
const MAX_FEE_BPS = 2000; // phí sàn + bản quyền trên 20% thì không đăng
const MAX_DAYS = 90;

const nftI = new Interface([
  'function setApprovalForAll(address operator, bool approved)',
  'function isApprovedForAll(address owner, address operator) view returns (bool)',
  'function ownerOf(uint256) view returns (address)',
  'function supportsInterface(bytes4) view returns (bool)',
]);
const ORDER_T = '(address maker,address taker,uint256 expiry,uint256 nonce,address erc20Token,uint256 erc20TokenAmount,(address recipient,uint256 amount,bytes feeData)[] fees,address nft,uint256 nftId)';
const helperI = new Interface([
  `function checkERC721SellOrder(${ORDER_T} order, address taker) view returns ((bool success,uint256 hashNonce,bytes32 orderHash,bool makerCheck,bool takerCheck,bool listingTimeCheck,bool expireTimeCheck,bool extraCheck,bool nonceCheck,bool feesCheck,bool erc20AddressCheck,bool erc721AddressCheck,bool erc721OwnerCheck,bool erc721ApprovedCheck,uint256 erc20TotalAmount) info, (uint256 balance,uint256 allowance,bool balanceCheck,bool allowanceCheck,bool listingTimeCheck,bool takerCheck) takerCheckInfo)`,
]);

const TYPES = {
  NFTSellOrder: [
    { type: 'address', name: 'maker' }, { type: 'address', name: 'taker' }, { type: 'uint256', name: 'expiry' },
    { type: 'uint256', name: 'nonce' }, { type: 'address', name: 'erc20Token' }, { type: 'uint256', name: 'erc20TokenAmount' },
    { type: 'Fee[]', name: 'fees' }, { type: 'address', name: 'nft' }, { type: 'uint256', name: 'nftId' }, { type: 'uint256', name: 'hashNonce' },
  ],
  Fee: [{ type: 'address', name: 'recipient' }, { type: 'uint256', name: 'amount' }, { type: 'bytes', name: 'feeData' }],
};
const DOMAIN = { name: 'ElementEx', version: '1.0.0', chainId: 56, verifyingContract: ELEMENT.EX.toLowerCase() };

export const approveData = () => nftI.encodeFunctionData('setApprovalForAll', [ELEMENT.EX, true]);

// expiry 256 bit: [saleKind 4][oracleSignature 4][0 152][extra 32][listingTime 32][expirationTime 32]
export const encodeExpiry = ({ oracle = 0, listingTime, expirationTime }) =>
  (BigInt(oracle & 0xf) << 248n) | (BigInt(listingTime) << 32n) | BigInt(expirationTime);
export function decodeExpiry(e) {
  const v = BigInt(e);
  return { saleKind: Number(v >> 252n), oracle: Number((v >> 248n) & 0xfn), extra: Number((v >> 64n) & 0xffffffffn), listingTime: Number((v >> 32n) & 0xffffffffn), expirationTime: Number(v & 0xffffffffn) };
}

export async function elementApi(cfg, path, { body, fetchFn = fetch } = {}) {
  if (!cfg.elementKey) throw new Error('Chưa có Element API key. Dán key ở mục Bán NFT (lấy miễn phí tại element.market → Developer).');
  const r = await fetchFn(ELEMENT.API + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'x-api-key': cfg.elementKey, 'content-type': 'application/json', accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const j = await r.json().catch(() => ({}));
  if (j.code !== 0) throw new Error(`Element: ${j.msg ?? j.message ?? `HTTP ${r.status}`}`);
  return j.data;
}

// Tạo lệnh bán (chưa ký) + kiểm tra trên chain bằng hợp đồng Helper của Element.
export async function buildListing(provider, cfg, { maker, contract, tokenId, priceBNB, days = 7, fetchFn, now = Math.floor(Date.now() / 1000) }) {
  const nft = getAddress(contract);
  const price = parseEther(String(priceBNB));
  if (price <= 0n) throw new Error('Giá bán phải lớn hơn 0');
  days = Math.min(MAX_DAYS, Math.max(1, Number(days) || 7));
  const c = new Contract(nft, nftI, provider);
  if (!(await c.supportsInterface('0x80ac58cd').catch(() => true))) throw new Error('Bot mới hỗ trợ đăng bán NFT ERC-721');
  const owner = await c.ownerOf(BigInt(tokenId)).catch(() => null);
  if (owner && owner.toLowerCase() !== maker.toLowerCase()) throw new Error(`NFT #${tokenId} không còn trong ví bạn`);

  const [nonceD, conf, feeD] = await Promise.all([
    elementApi(cfg, `/openapi/v1/orders/nonce?chain=bsc&maker=${maker.toLowerCase()}&schema=erc721&count=1`, { fetchFn }),
    elementApi(cfg, '/openapi/v1/orders/confData?chain=bsc', { fetchFn }).catch(() => ({})),
    elementApi(cfg, '/openapi/v1/collection/fee', { body: { chain: 'bsc', data: [{ contractAddress: nft.toLowerCase() }] }, fetchFn }),
  ]);
  const f = feeD?.feeList?.[0] ?? {};
  const fees = [];
  const feeRows = [];
  for (const [pts, to, label] of [[f.protocolFeePoints, f.protocolFeeAddress, 'Phí sàn Element'], [f.royaltyFeePoints, f.royaltyFeeAddress, 'Bản quyền dự án']]) {
    if (!pts || !to) continue;
    const amount = (price * BigInt(pts)) / 10000n;
    fees.push({ recipient: to.toLowerCase(), amount: amount.toString(), feeData: '0x' });
    feeRows.push({ label, pct: Number(pts) / 100, bnb: Number(formatEther(amount)) });
  }
  const feeTotal = fees.reduce((s, x) => s + BigInt(x.amount), 0n);
  const listingTime = now - 60;
  const order = {
    maker: maker.toLowerCase(),
    taker: ZeroAddress,
    expiry: encodeExpiry({ oracle: Number(conf?.oracleSignature ?? 0), listingTime, expirationTime: listingTime + 60 + days * 86400 }).toString(),
    nonce: String(nonceD?.nonce ?? 0),
    erc20Token: NATIVE,
    erc20TokenAmount: (price - feeTotal).toString(),
    fees,
    nft: nft.toLowerCase(),
    nftId: BigInt(tokenId).toString(),
  };

  let approved = null;
  try {
    const raw = await provider.call({ to: ELEMENT.HELPER, data: helperI.encodeFunctionData('checkERC721SellOrder', [order, ZeroAddress]) });
    const { info } = helperI.decodeFunctionResult('checkERC721SellOrder', raw);
    order.hashNonce = info.hashNonce.toString();
    if (!info.erc721OwnerCheck) throw new Error(`Element báo ví bạn không giữ NFT #${tokenId}`);
    if (!info.feesCheck) throw new Error('Element từ chối phần phí của lệnh, thử lại sau');
    if (!info.nonceCheck) throw new Error('Nonce lệnh bị trùng, bấm đăng bán lại');
    approved = info.erc721ApprovedCheck;
  } catch (e) {
    if (/Element|Nonce/.test(e.message)) throw e;
    // RPC không gọi được Helper: tự đọc quyền, hashNonce mặc định 0 (ví chưa từng huỷ hàng loạt lệnh).
    order.hashNonce ??= '0';
    approved = await c.isApprovedForAll(maker, ELEMENT.EX).catch(() => false);
  }
  const typedData = { types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }], ...TYPES }, primaryType: 'NFTSellOrder', domain: { ...DOMAIN }, message: order };
  return {
    order, typedData, needsApproval: !approved,
    priceBNB: Number(formatEther(price)), receiveBNB: Number(formatEther(price - feeTotal)), fees: feeRows,
    expiresAt: new Date((listingTime + 60 + days * 86400) * 1000).toISOString(), days,
  };
}

// Kiểm tra lại lệnh ngay trước khi ký: chỉ ký đúng thứ bạn đã xem.
export function checkListing(l, { maker, contract, tokenId, priceBNB, minPriceBNB = 0 }) {
  const m = l.typedData.message;
  const d = l.typedData.domain;
  const errs = [];
  if (d.verifyingContract.toLowerCase() !== ELEMENT.EX.toLowerCase() || Number(d.chainId) !== 56 || d.name !== 'ElementEx') errs.push('Lệnh không dành cho sàn Element trên BSC');
  if (l.typedData.primaryType !== 'NFTSellOrder') errs.push('Đây không phải lệnh bán');
  if (m.maker.toLowerCase() !== maker.toLowerCase()) errs.push('Người bán không phải ví bạn');
  if (m.taker.toLowerCase() !== ZeroAddress) errs.push('Lệnh chỉ cho 1 người mua riêng: bị chặn');
  if (m.erc20Token.toLowerCase() !== NATIVE) errs.push('Lệnh không nhận BNB');
  if (m.nft.toLowerCase() !== contract.toLowerCase() || m.nftId !== BigInt(tokenId).toString()) errs.push('Sai NFT');
  const total = BigInt(m.erc20TokenAmount) + m.fees.reduce((s, x) => s + BigInt(x.amount), 0n);
  if (total !== parseEther(String(priceBNB))) errs.push('Giá trong lệnh khác giá bạn chọn');
  if (total > 0n && (m.fees.reduce((s, x) => s + BigInt(x.amount), 0n) * 10000n) / total > BigInt(MAX_FEE_BPS)) errs.push('Phí sàn + bản quyền trên 20%: không đăng');
  const ex = decodeExpiry(m.expiry);
  if (ex.saleKind !== 0 || ex.expirationTime - ex.listingTime > (MAX_DAYS + 1) * 86400) errs.push('Thời hạn lệnh bất thường');
  if (Number(priceBNB) < Number(minPriceBNB || 0)) errs.push(`Giá thấp hơn mức sàn bạn đặt (${minPriceBNB} BNB)`);
  return errs;
}

// Tìm chữ ký trong kết quả trả về của baw (tên trường có thể khác nhau giữa các bản).
export function findSignature(o) {
  if (typeof o === 'string') return /^0x[0-9a-fA-F]{130}$/.test(o) ? o : null;
  if (o && typeof o === 'object') for (const v of Object.values(o)) { const s = findSignature(v); if (s) return s; }
  return null;
}

// Ký bằng ví Agentic. Không có chữ ký ngay thì hỏi lại kết quả vài lần (tối đa ~30 giây).
export async function signListing(cfg, maker, typedData, { wait = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const p = wallet.signTypedPreview({ chainId: cfg.binanceChainId, address: maker, typedData });
  if (!p.success) throw new Error(`Binance từ chối ký: ${p.error?.message ?? JSON.stringify(p.error)}`);
  const x = wallet.signExecute(p.data.requestId);
  if (!x.success) throw new Error(`Ký lỗi: ${x.error?.message ?? JSON.stringify(x.error)}`);
  let sig = findSignature(x.data);
  for (let i = 0; !sig && x.data?.orderId && i < 15; i++) {
    await wait(2000);
    const r = wallet.signResult(x.data.orderId);
    if (/FAIL|REJECT|CANCEL|EXPIRE/i.test(r.data?.status ?? '')) throw new Error(`Ký không thành công: ${r.data.status}`);
    sig = findSignature(r.data);
  }
  if (!sig) throw new Error(x.data?.status ? `Chưa có chữ ký (trạng thái ${x.data.status}). Nếu app Binance hỏi, hãy duyệt rồi bấm lại.` : 'Không nhận được chữ ký từ ví');
  const { EIP712Domain, ...types } = typedData.types;
  if (verifyTypedData(typedData.domain, types, typedData.message, sig).toLowerCase() !== maker.toLowerCase()) throw new Error('Chữ ký không khớp ví bạn: huỷ, không gửi lên sàn');
  return sig;
}

// Gửi lệnh đã ký lên Element (cùng định dạng toOrderRequest của SDK).
export async function postListing(cfg, typedData, sig, { fetchFn } = {}) {
  const m = typedData.message;
  const { EIP712Domain, ...types } = typedData.types;
  const s = Signature.from(sig);
  const ex = decodeExpiry(m.expiry);
  const total = BigInt(m.erc20TokenAmount) + m.fees.reduce((a, x) => a + BigInt(x.amount), 0n);
  const req = {
    exchange: ELEMENT.EX.toLowerCase(), maker: m.maker, taker: m.taker, side: 1, saleKind: ex.saleKind, oracleSignature: ex.oracle,
    paymentToken: ZeroAddress, quantity: '1', basePrice: total.toString(), extra: String(ex.extra), listingTime: ex.listingTime, expirationTime: ex.expirationTime,
    metadata: { asset: { id: m.nftId, address: m.nft }, schema: 'ERC721' }, fees: m.fees, nonce: m.nonce, hashNonce: m.hashNonce,
    hash: TypedDataEncoder.hash(typedData.domain, types, m), signatureType: 0, v: s.v, r: s.r, s: s.s, chain: 'bsc',
  };
  const d = await elementApi(cfg, '/openapi/v1/orders/post', { body: req, fetchFn });
  return { orderId: d?.orderId ?? null, url: `https://element.market/assets/bsc/${m.nft}/${m.nftId}` };
}

// Bước cấp quyền cho sàn: chỉ đúng setApprovalForAll(Element, true) trên hợp đồng NFT bạn đang bán.
export function previewApproveElement(cfg, maker, contract) {
  const data = approveData();
  const p = wallet.previewCall({ chainId: cfg.binanceChainId, from: maker, to: getAddress(contract), valueWei: 0n, data });
  if (!p.success) return { ok: false, error: `Binance từ chối: ${p.error?.message ?? JSON.stringify(p.error)}` };
  const d = p.data;
  const risks = (d.risks?.riskDetails ?? []).map((r) => `[${r.riskType}] ${r.title}: ${r.description}`);
  const out = (d.simulationResult?.balanceChanges ?? []).filter((b) => String(b.amount ?? b.change ?? '').startsWith('-') && !/gas/i.test(JSON.stringify(b)));
  if (out.length) return { ok: false, error: 'Mô phỏng cho thấy ví bị trừ tiền/NFT khi cấp quyền: đã chặn', risks };
  return { ok: true, requestId: d.requestId, risks, requireConfirmation: d.requireConfirmation };
}

