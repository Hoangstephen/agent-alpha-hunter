// Chấm điểm rủi ro hợp đồng (0-100, càng cao càng an toàn) + chặn calldata nguy hiểm.
// Đây là bộ lọc thô, KHÔNG thay cho việc tự đọc hợp đồng. Bot không đưa lời khuyên đầu tư.
import { Interface, id, dataSlice, getAddress } from 'ethers';
import { tryCall, erc721 } from './chain.js';
import { KNOWN } from './projects.js';
import { resolveAgentId } from './agentid.js';
import { ADDR } from './config.js';
import { sitePerWallet } from './sitefacts.js';
const AGENT_ID_REGISTRY = ADDR.AGENT_ID_REGISTRY;

const EIP1967_IMPL = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';

// Selector không bao giờ được phép xuất hiện trong lệnh mint của bot (kiểu drainer kinh điển).
export const BLOCKED_SELECTORS = {
  '0x095ea7b3': 'approve(address,uint256)',
  '0xa22cb465': 'setApprovalForAll(address,bool)',
  '0xa9059cbb': 'transfer(address,uint256)',
  '0x23b872dd': 'transferFrom(address,address,uint256)',
  '0x42842e0e': 'safeTransferFrom(address,address,uint256)',
  '0xb88d4fde': 'safeTransferFrom(address,address,uint256,bytes)',
  '0xd505accf': 'permit(...)',
  '0x39509351': 'increaseAllowance(address,uint256)',
  '0x2e1a7d4d': 'withdraw(uint256)',
  '0x3ccfd60b': 'withdraw()',
};

// Lấy danh sách opcode và hằng PUSH4 (thường là selector của hàm) từ bytecode.
export function scanBytecode(code) {
  const bytes = Buffer.from(code.replace(/^0x/, ''), 'hex');
  const ops = new Set();
  const push4 = new Set();
  const push20 = new Set();
  // Chuỗi chữ trong bytecode (thông báo lỗi require/revert): nguồn đọc luật mint của mọi dự án.
  const strings = [];
  let cur = '';
  const flush = () => { const t = cur.replace(/\0+$/, '').trim(); if (t.length >= 6 && /[a-z]{3}/i.test(t)) strings.push(t); cur = ''; };
  for (let i = 0; i < bytes.length; i++) {
    const op = bytes[i];
    ops.add(op);
    if (op >= 0x60 && op <= 0x7f) {
      const n = op - 0x5f;
      const data = bytes.subarray(i + 1, i + 1 + n);
      if (n === 4) push4.add('0x' + data.toString('hex'));
      if (n === 20) push20.add('0x' + data.toString('hex'));
      const txt = data.toString('latin1').replace(/\0+$/, '');
      // Chuỗi dài hơn 32 ký tự bị cắt thành nhiều PUSH32 (xen lệnh nhỏ): nối lại tới khi gặp đoạn chưa đầy.
      if (n >= 6) {
        const printable = txt.length >= 3 && /^[\x20-\x7e]+$/.test(txt);
        if (printable) cur += txt;
        if (!printable || txt.length < n) flush();
      }
      i += n;
    }
  }
  flush();
  return { hasSelfdestruct: ops.has(0xff), hasDelegatecall: ops.has(0xf4), push4, push20, strings: [...new Set(strings)] };
}

export const sel = (sig) => id(sig).slice(0, 10);

const COMMON_MINTS = ['mint()', 'mint(uint256)', 'publicMint(uint256)', 'publicMint()', 'mint(address,uint256)', 'claim()', 'freeMint()', 'freeMint(uint256)', 'mintPublic(uint256)', 'agentMint()', 'agentMint(uint256)'];
const PRICE_GETTERS = ['price', 'mintPrice', 'cost', 'PRICE', 'MINT_PRICE', 'publicPrice', 'currentPrice', 'mintCost', 'salePrice', 'publicSalePrice', 'PUBLIC_PRICE', 'paidPrice', 'PAID_PRICE', 'paidMintPrice', 'mintFee', 'fee'];
const PER_WALLET_GETTERS = ['maxPerWallet', 'MAX_PER_WALLET', 'maxMintPerWallet', 'maxPerAddress', 'MAX_PER_ADDRESS', 'walletLimit', 'maxMintsPerWallet', 'mintLimit', 'perWallet', 'PER_WALLET', 'walletCap', 'MAX_MINTS', 'MAX_PER_WALLET_MINTS'];
// Giá theo từng ví (kiểu "mint đầu free, sau đó trả phí").
const WALLET_PRICE_GETTERS = ['priceFor', 'getPrice', 'mintPriceFor', 'nextPrice', 'priceOf', 'currentPriceFor', 'quote', 'getMintPrice'];
const START_GETTERS = ['mintStart', 'startTime', 'saleStart', 'publicSaleStart', 'mintStartTime', 'openTime', 'startAt', 'START_TIME', 'mintOpenAt'];
const OPEN_GETTERS = ['mintOpen', 'mintEnabled', 'isMintOpen', 'saleActive', 'publicSaleActive', 'mintActive', 'isActive', 'open'];
export const AGENT_MINT_FN = 'mint(uint256,uint256)';
const AGENT_QUOTE_FN = 'quote(uint256,uint256)';
const quoteI = new Interface(['function quote(uint256,uint256) view returns (uint256)']);
const SEL_OWNER_OF = '0x6352211e'; // ownerOf(uint256): có trong mọi ERC-721 kể cả không khai ERC165
// Số đã mint: nhiều hợp đồng không có totalSupply() mà dùng tên khác.
export const MINTED_GETTERS = ['totalSupply', 'totalMinted', 'totalMints', 'mintedCount', 'numMinted', 'minted', 'totalMint', 'currentIndex', 'nextTokenId', 'currentTokenId', 'tokenIdCounter', 'tokenCounter', 'mintedSupply', 'currentSupply'];
const MAX_SUPPLY_GETTERS = ['maxSupply', 'MAX_SUPPLY', 'collectionSize', 'maxTokens', 'MAX_TOKENS', 'TOTAL_SUPPLY', 'supplyCap', 'maxMintSupply', 'MAX_MINT_SUPPLY', 'maxTotalSupply', 'MAX_NFT', 'maxNfts', 'totalLimit', 'cap'];
const PER_TX_GETTERS = ['maxPerTx', 'MAX_PER_TX', 'maxMintAmountPerTx', 'maxMintPerTx', 'maxBatchSize'];

// Thử lần lượt các getter uint256 không tham số, trả về {getter, value} đầu tiên đọc được.
async function firstUint(provider, address, names) {
  const vals = await Promise.all(names.map((g) => tryCall(provider, address, new Interface([`function ${g}() view returns (uint256)`]), g)));
  const i = vals.findIndex((v) => v !== null);
  return i < 0 ? null : { getter: names[i], value: vals[i] };
}

// Đọc mọi getter cùng lúc, trả về tất cả giá trị đọc được (để chọn số đã mint đúng nhất).
async function allUints(provider, address, names) {
  const vals = await Promise.all(names.map((g) => tryCall(provider, address, new Interface([`function ${g}() view returns (uint256)`]), g)));
  return names.map((g, i) => ({ getter: g, value: vals[i] })).filter((r) => r.value !== null);
}

// Số đã mint: một số hợp đồng có totalSupply() thấp hơn số đã mint thật (đã đốt, tách đợt...).
// Lấy số lớn nhất trong các getter hợp lý (không vượt tổng cung).
export function pickMinted(rows, maxSupply) {
  const ok = rows.filter((r) => r.value < 10n ** 12n && (maxSupply == null || r.value <= maxSupply));
  return ok.reduce((best, r) => (!best || r.value > best.value ? r : best), null);
}

// Getter phổ biến nhất trước (2 cái đầu), chỉ khi không có mới thử các tên hiếm, để đỡ tốn RPC.
async function commonFirst(provider, address, names) {
  return (await firstUint(provider, address, names.slice(0, 2))) ?? firstUint(provider, address, names.slice(2));
}

export function findMintCandidates({ abi, push4 }) {
  if (abi) {
    return abi
      .filter((f) => f.type === 'function' && /mint|claim/i.test(f.name) && !/owner|admin|airdrop|dev|team|reserve|batchMintTo/i.test(f.name))
      .filter((f) => f.stateMutability === 'payable' || f.stateMutability === 'nonpayable')
      .map((f) => `${f.name}(${f.inputs.map((i) => i.type).join(',')})`);
  }
  return COMMON_MINTS.filter((s) => push4.has(sel(s)));
}

export function scoreRisk(f) {
  let score = 100;
  const flags = [];
  const hit = (pts, msg) => { score -= pts; flags.push(`-${pts} ${msg}`); };
  if (!f.hasCode) return { score: 0, flags: ['Không phải hợp đồng (ví thường / sai địa chỉ)'] };
  if (f.verified === false) hit(35, 'Mã nguồn CHƯA verify trên BscScan');
  if (f.verified === null) hit(10, 'Không kiểm tra được verify (thiếu ETHERSCAN_API_KEY)');
  if (f.isProxy) hit(15, 'Proxy nâng cấp được: chủ dự án đổi logic bất cứ lúc nào');
  if (f.hasSelfdestruct) hit(20, 'Có SELFDESTRUCT trong bytecode');
  if (f.hasDelegatecall && !f.isProxy) hit(10, 'Có DELEGATECALL (gọi code bên ngoài)');
  if (!f.isNft) hit(25, 'Không khai báo ERC-721/1155 qua supportsInterface');
  if (!f.mintCandidates.length) hit(15, 'Không tìm thấy hàm mint công khai');
  if (f.mintCandidates.some((s) => /bytes32\[\]|bytes\)|bytes,/.test(s))) flags.push('ℹ Mint cần chữ ký/whitelist proof: có thể chỉ mint được qua web của dự án');
  if (f.ownerAddr) flags.push(`ℹ Có owner: ${f.ownerAddr}`);
  return { score: Math.max(0, score), flags };
}

async function explorerSource(address, key) {
  if (!key) return { verified: null, abi: null };
  const url = `https://api.etherscan.io/v2/api?chainid=56&module=contract&action=getsourcecode&address=${address}&apikey=${key}`;
  try {
    const j = await (await fetch(url, { signal: AbortSignal.timeout(8000) })).json();
    const r = j.result?.[0];
    if (!r) return { verified: null, abi: null };
    const verified = Boolean(r.SourceCode);
    return { verified, abi: verified ? JSON.parse(r.ABI) : null, contractName: r.ContractName, implementation: r.Implementation || null };
  } catch {
    return { verified: null, abi: null };
  }
}

// Stablecoin trên BSC (nguồn: bảng Common Token Addresses của skill binance-agentic-wallet).
export const STABLES = {
  '0x55d398326f99059ff775485246999027b3197955': 'USDT',
  '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': 'USDC',
  '0xce24439f2d9c6a2289f741120fe202248b666666': 'U',
  '0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d': 'USD1',
};
const PAY_TOKEN_GETTERS = ['paymentToken', 'payToken', 'currency', 'usdt', 'USDT', 'stablecoin', 'quoteToken', 'mintToken'];
const MINTED_BY_GETTERS = ['numberMinted', 'mintedCount', 'minted', 'mintedBy', 'mintCount', 'walletMints', 'mintedPerWallet', 'mintsOf', 'originalMints', 'mintedOf'];

async function firstOfSig(provider, address, names, sig, args = []) {
  const vals = await Promise.all(names.map((g) => tryCall(provider, address, new Interface([`function ${g}(${sig.in}) view returns (${sig.out})`]), g, args)));
  const i = vals.findIndex((v) => v !== null);
  return i < 0 ? null : { getter: names[i], value: vals[i] };
}

// Dò số BNB cần gửi cho lần mint tiếp theo: gọi thử (eth_call, không gửi gì) với từng mức giá,
// lấy mức nhỏ nhất không bị revert. Dùng cho dự án giá thay đổi theo ví / theo lần mint.
export async function probeValue(provider, { from, to, data, candidates }) {
  const uniq = [...new Set(candidates.filter((v) => v != null).map((v) => BigInt(v)))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  let lastError = null;
  for (const v of uniq) {
    try {
      await provider.call({ from, to, data, value: v });
      return { ok: true, valueWei: v };
    } catch (e) {
      lastError = e.shortMessage || e.reason || e.message;
    }
  }
  return { ok: false, error: lastError };
}

async function payTokenOf(provider, address) {
  const all = await Promise.all(PAY_TOKEN_GETTERS.map((g) => tryCall(provider, address, new Interface([`function ${g}() view returns (address)`]), g)));
  for (const t of all) {
    if (t && STABLES[t.toLowerCase()]) {
      const dec = await tryCall(provider, t, new Interface(['function decimals() view returns (uint8)']), 'decimals');
      return { address: getAddress(t), symbol: STABLES[t.toLowerCase()], decimals: Number(dec ?? 18) };
    }
  }
  return null;
}

// Số NFT ví này đã mint/đang giữ ở hợp đồng, để trừ vào giới hạn mỗi ví.
async function mintedBy(provider, address, wallet) {
  if (!wallet) return null;
  const vals = await Promise.all(MINTED_BY_GETTERS.map((g) => tryCall(provider, address, new Interface([`function ${g}(address) view returns (uint256)`]), g, [wallet])));
  return vals.find((v) => v !== null) ?? tryCall(provider, address, erc721, 'balanceOf', [wallet]);
}

export async function inspectContract(provider, address, cfg, walletAddr) {
  address = getAddress(address);
  const code = await provider.getCode(address);
  const hasCode = code && code !== '0x';
  if (!hasCode) return { address, ...scoreRisk({ hasCode: false }) };

  const { hasSelfdestruct, hasDelegatecall, push4, push20, strings } = scanBytecode(code);
  // Mọi lệnh đọc chạy song song để nhanh.
  const call = (fn, args) => tryCall(provider, address, erc721, fn, args);
  const [implSlot, src, is721, is1155, ownerAddr, mintedRaw, maxSupplyRaw, p, perWallet, perTx, paused, name, payTokenRaw, walletMinted] = await Promise.all([
    provider.getStorage(address, EIP1967_IMPL).catch(() => '0x0'),
    explorerSource(address, cfg.etherscanKey),
    call('supportsInterface', ['0x80ac58cd']),
    call('supportsInterface', ['0xd9b67a26']),
    call('owner'), allUints(provider, address, MINTED_GETTERS), commonFirst(provider, address, MAX_SUPPLY_GETTERS),
    firstUint(provider, address, PRICE_GETTERS),
    firstUint(provider, address, PER_WALLET_GETTERS),
    firstUint(provider, address, PER_TX_GETTERS),
    call('paused'), call('name'),
    payTokenOf(provider, address),
    mintedBy(provider, address, walletAddr),
  ]);
  const isProxy = BigInt(implSlot) !== 0n;
  const [walletPrice, startAt, openFlag, agentBal] = await Promise.all([
    walletAddr ? firstOfSig(provider, address, WALLET_PRICE_GETTERS, { in: 'address', out: 'uint256' }, [walletAddr]) : null,
    firstOfSig(provider, address, START_GETTERS, { in: '', out: 'uint256' }),
    firstOfSig(provider, address, OPEN_GETTERS, { in: '', out: 'bool' }),
    walletAddr ? tryCall(provider, AGENT_ID_REGISTRY, erc721, 'balanceOf', [walletAddr]) : null,
  ]);
  // Số quá lớn (vd. type(uint256).max) nghĩa là không giới hạn, không phải số thật.
  const sane = (r) => (r && r.value < 10n ** 12n ? r.value : null);
  const maxSupply = sane(maxSupplyRaw);
  const mintedPick = pickMinted(mintedRaw, maxSupply);
  const totalSupply = mintedPick?.value ?? null;
  const price = p && { getter: p.getter, wei: p.value };
  const payToken = price ? payTokenRaw : null;

  // Kiểu "mint theo Agent ID": mint(agentTokenId, số lượng) + quote(agentTokenId, số lượng) trả giá BNB.
  const usesAgentId = push20.has(AGENT_ID_REGISTRY.toLowerCase());
  const agentMint = push4.has(sel(AGENT_MINT_FN)) && push4.has(sel(AGENT_QUOTE_FN)) && (usesAgentId || Boolean(KNOWN[address.toLowerCase()]?.agentMint));
  let agent = null;
  let agentPrice = null;
  if (agentMint && walletAddr) {
    agent = await resolveAgentId(provider, walletAddr).catch(() => null);
    if (agent?.ok) agentPrice = await tryCall(provider, address, quoteI, 'quote', [agent.tokenId, 1n]);
  }
  const candidates = findMintCandidates({ abi: src.abi, push4 });
  const facts = {
    hasCode, hasSelfdestruct, hasDelegatecall, isProxy,
    verified: src.verified, isNft: Boolean(is721 || is1155 || push4.has(SEL_OWNER_OF)),
    mintCandidates: agentMint ? [AGENT_MINT_FN, ...candidates.filter((c) => c !== AGENT_MINT_FN)] : candidates,
    ownerAddr,
  };
  return {
    address,
    contractName: src.contractName,
    standard: is721 ? 'ERC721' : is1155 ? 'ERC1155' : push4.has(SEL_OWNER_OF) ? 'ERC721' : '?',
    name, totalSupply, mintedGetter: mintedPick?.getter ?? null, maxSupply, abi: src.abi,
    price: price ?? (agentPrice != null ? { getter: 'quote', wei: agentPrice } : null),
    agentMint, agent: agent && { ...agent, tokenId: agent.tokenId.toString() },
    revertStrings: strings.slice(0, 60),
    errorNames: (src.abi ?? []).filter((x) => x.type === 'error').map((x) => x.name),
    usesAgentId,
    maxPerWallet: perWallet?.value ?? (KNOWN[address.toLowerCase()]?.perWallet != null ? BigInt(KNOWN[address.toLowerCase()].perWallet) : sitePerWallet(address) != null ? BigInt(sitePerWallet(address)) : null),
    perWalletFrom: perWallet?.value != null ? 'contract' : KNOWN[address.toLowerCase()]?.perWallet != null ? 'known' : sitePerWallet(address) != null ? 'site' : null,
    maxPerTx: perTx?.value ?? null,
    paused, payToken, walletMinted,
    walletPrice: walletPrice?.value ?? null,
    startAt: startAt && startAt.value > 1_000_000_000n && startAt.value < 10_000_000_000n ? Number(startAt.value) : null,
    mintOpen: openFlag ? openFlag.value : null,
    hasAgentId: agentBal == null ? null : agentBal > 0n,
    ...facts,
    ...scoreRisk(facts),
  };
}

// Chặn cứng trước khi gửi bất cứ thứ gì sang baw.
export function guardCall({ to, target, data, valueWei, maxPerMintWei }) {
  const errs = [];
  if (getAddress(to) !== getAddress(target)) errs.push('Địa chỉ gọi khác hợp đồng đã kiểm tra');
  const selector = data.length >= 10 ? dataSlice(data, 0, 4) : '0x';
  if (BLOCKED_SELECTORS[selector]) errs.push(`Calldata là ${BLOCKED_SELECTORS[selector]}: dấu hiệu drainer, bị chặn`);
  if (valueWei > maxPerMintWei) errs.push(`Giá trị ${valueWei} wei vượt trần mỗi lần mint (${maxPerMintWei} wei)`);
  return errs;
}

// Mint trả bằng stablecoin phải approve trước. Chỉ cho phép: token là stablecoin đã biết,
// người được dùng tiền là đúng hợp đồng NFT đang mint, số tiền đúng bằng giá (không approve vô hạn).
export function guardApprove({ token, spender, target, amount, expected }) {
  const errs = [];
  if (!STABLES[token.toLowerCase()]) errs.push('Token thanh toán không phải stablecoin đã biết');
  if (getAddress(spender) !== getAddress(target)) errs.push('Approve cho địa chỉ khác hợp đồng NFT: bị chặn');
  if (amount !== expected) errs.push('Số tiền approve khác giá mint: bị chặn');
  return errs;
}
