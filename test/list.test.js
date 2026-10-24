import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Interface, Wallet, ZeroAddress, parseEther, AbiCoder, TypedDataEncoder } from 'ethers';
import { ELEMENT, buildListing, checkListing, signListing, postListing, encodeExpiry, decodeExpiry, findSignature, approveData } from '../src/list.js';
import { suggestPrice, autoSellRun, saveAutoSell, autoSellConfig, mintCostBNB } from '../src/autosell.js';

process.env.BAW_BIN = new URL('./fake-baw.mjs', import.meta.url).pathname;
const KEY = Wallet.createRandom();
process.env.FAKE_SIGN_KEY = KEY.privateKey;
const MAKER = KEY.address;
const NFT = '0x2222222222222222222222222222222222222222';
const cfg = { elementKey: 'test-key', binanceChainId: '56' };
const coder = AbiCoder.defaultAbiCoder();

const nftI = new Interface(['function ownerOf(uint256) view returns (address)', 'function supportsInterface(bytes4) view returns (bool)', 'function isApprovedForAll(address,address) view returns (bool)']);
// Provider giả: NFT thuộc ví MAKER, Helper của Element trả hashNonce = 7 và trạng thái quyền theo `approved`.
function fakeProvider({ approved = true, owner = MAKER } = {}) {
  return {
    async call({ to, data }) {
      const s = data.slice(0, 10);
      if (to.toLowerCase() === ELEMENT.HELPER.toLowerCase()) {
        const info = [true, 7n, '0x' + '00'.repeat(32), true, true, true, true, true, true, true, true, true, owner === MAKER, approved, 0n];
        return coder.encode(['(bool,uint256,bytes32,bool,bool,bool,bool,bool,bool,bool,bool,bool,bool,bool,uint256)', '(uint256,uint256,bool,bool,bool,bool)'], [info, [0n, 0n, true, true, true, true]]);
      }
      if (s === nftI.getFunction('ownerOf').selector) return coder.encode(['address'], [owner]);
      if (s === nftI.getFunction('supportsInterface').selector) return coder.encode(['bool'], [true]);
      if (s === nftI.getFunction('isApprovedForAll').selector) return coder.encode(['bool'], [approved]);
      throw new Error('call lạ ' + s);
    },
  };
}
// API Element giả: nonce 3, phí sàn 2% + bản quyền 5%, nhận lệnh post.
function fakeElement(posted = []) {
  return async (url, init) => {
    const ok = (data) => ({ status: 200, json: async () => ({ code: 0, data }) });
    if (url.includes('/orders/nonce')) return ok({ nonce: 3 });
    if (url.includes('/orders/confData')) return ok({ oracleSignature: 1 });
    if (url.includes('/collection/fee')) return ok({ feeList: [{ protocolFeePoints: 200, protocolFeeAddress: '0x00000000000000000000000000000000000000f1', royaltyFeePoints: 500, royaltyFeeAddress: '0x00000000000000000000000000000000000000f2' }] });
    if (url.includes('/orders/post')) { posted.push(JSON.parse(init.body)); return ok({ orderId: 'ord-1' }); }
    return { status: 404, json: async () => ({ code: 404, msg: 'not found' }) };
  };
}

test('expiry: mã hoá / giải mã đúng bố cục bit của Element', () => {
  const e = encodeExpiry({ oracle: 1, listingTime: 1_700_000_000, expirationTime: 1_700_604_800 });
  assert.deepEqual(decodeExpiry(e), { saleKind: 0, oracle: 1, extra: 0, listingTime: 1_700_000_000, expirationTime: 1_700_604_800 });
  assert.equal('0x' + e.toString(16).padStart(64, '0').slice(0, 2), '0x01');
});

test('buildListing: phí tính đúng, nhận về = giá - phí, hashNonce từ Helper', async () => {
  const l = await buildListing(fakeProvider(), cfg, { maker: MAKER, contract: NFT, tokenId: '42', priceBNB: '0.1', days: 7, fetchFn: fakeElement() });
  assert.equal(l.needsApproval, false);
  assert.equal(l.priceBNB, 0.1);
  assert.equal(l.receiveBNB, 0.093);
  assert.equal(l.typedData.message.hashNonce, '7');
  assert.equal(l.typedData.message.nonce, '3');
  assert.equal(l.typedData.message.erc20TokenAmount, parseEther('0.093').toString());
  assert.equal(decodeExpiry(l.typedData.message.expiry).oracle, 1);
  assert.deepEqual(checkListing(l, { maker: MAKER, contract: NFT, tokenId: '42', priceBNB: '0.1' }), []);
});

test('buildListing: chưa cấp quyền cho Element thì báo needsApproval; NFT không còn trong ví thì báo lỗi', async () => {
  const l = await buildListing(fakeProvider({ approved: false }), cfg, { maker: MAKER, contract: NFT, tokenId: '42', priceBNB: '0.1', fetchFn: fakeElement() });
  assert.equal(l.needsApproval, true);
  await assert.rejects(buildListing(fakeProvider({ owner: '0x000000000000000000000000000000000000dEaD' }), cfg, { maker: MAKER, contract: NFT, tokenId: '42', priceBNB: '0.1', fetchFn: fakeElement() }), /không còn trong ví/);
  await assert.rejects(buildListing(fakeProvider(), { elementKey: '' }, { maker: MAKER, contract: NFT, tokenId: '42', priceBNB: '0.1', fetchFn: fakeElement() }), /API key/);
});

test('checkListing: chặn lệnh bị sửa (sai người nhận, người mua riêng, đổi token, giá dưới giá sàn, phí quá cao)', async () => {
  const fresh = () => buildListing(fakeProvider(), cfg, { maker: MAKER, contract: NFT, tokenId: '42', priceBNB: '0.1', fetchFn: fakeElement() });
  const args = { maker: MAKER, contract: NFT, tokenId: '42', priceBNB: '0.1' };
  let l = await fresh(); l.typedData.message.taker = '0x000000000000000000000000000000000000bEEF';
  assert.match(checkListing(l, args).join(), /người mua riêng/);
  l = await fresh(); l.typedData.message.erc20Token = '0x55d398326f99059ff775485246999027b3197955';
  assert.match(checkListing(l, args).join(), /không nhận BNB/);
  l = await fresh(); l.typedData.domain.verifyingContract = '0x000000000000000000000000000000000000bEEF';
  assert.match(checkListing(l, args).join(), /sàn Element/);
  l = await fresh(); l.typedData.message.erc20TokenAmount = '1';
  assert.match(checkListing(l, args).join(), /Giá trong lệnh khác/);
  l = await fresh();
  assert.match(checkListing(l, { ...args, minPriceBNB: 0.5 }).join(), /mức sàn/);
  l = await fresh(); l.typedData.message.fees[1].amount = parseEther('0.05').toString(); l.typedData.message.erc20TokenAmount = parseEther('0.048').toString();
  assert.match(checkListing(l, args).join(), /trên 20%/);
});

test('signListing + postListing: ký qua baw sign-message, kiểm chữ ký, gửi đúng định dạng Element', async () => {
  const l = await buildListing(fakeProvider(), cfg, { maker: MAKER, contract: NFT, tokenId: '42', priceBNB: '0.1', fetchFn: fakeElement() });
  const sig = await signListing(cfg, MAKER, l.typedData);
  assert.match(sig, /^0x[0-9a-f]{130}$/);
  const posted = [];
  const r = await postListing(cfg, l.typedData, sig, { fetchFn: fakeElement(posted) });
  assert.equal(r.orderId, 'ord-1');
  const req = posted[0];
  assert.equal(req.basePrice, parseEther('0.1').toString());
  assert.equal(req.side, 1);
  assert.equal(req.paymentToken, ZeroAddress);
  assert.equal(req.exchange, ELEMENT.EX.toLowerCase());
  assert.equal(req.oracleSignature, 1);
  const { EIP712Domain, ...types } = l.typedData.types;
  assert.equal(req.hash, TypedDataEncoder.hash(l.typedData.domain, types, l.typedData.message));
  // Chữ ký của ví khác: không gửi lên sàn.
  await assert.rejects(signListing(cfg, '0x000000000000000000000000000000000000dEaD', l.typedData), /không khớp/);
});

test('findSignature + approveData: chỉ cấp quyền cho đúng sàn Element', () => {
  const s = '0x' + 'ab'.repeat(65);
  assert.equal(findSignature({ data: { result: { sig: s } } }), s);
  assert.equal(findSignature({ x: '0x1234' }), null);
  const d = new Interface(['function setApprovalForAll(address,bool)']).decodeFunctionData('setApprovalForAll', approveData());
  assert.equal(d[0], ELEMENT.EX);
  assert.equal(d[1], true);
});

test('suggestPrice: lấy cao nhất trong trung vị / giá mint + lời / giá sàn; không có dữ liệu thì không đăng', () => {
  const a = { markupPct: 30, minPriceBNB: 0 };
  assert.equal(suggestPrice({ medianBNB: 0.05, costBNB: 0.01 }, a), 0.05);
  assert.equal(suggestPrice({ medianBNB: 0.01, costBNB: 0.02 }, a), 0.026);
  assert.equal(suggestPrice({ medianBNB: null, costBNB: null }, a), null);
  assert.equal(suggestPrice({ medianBNB: 0.01 }, { markupPct: 0, minPriceBNB: 0.03 }), 0.03);
  assert.equal(suggestPrice({ costBNB: 0 }, { markupPct: 30, minPriceBNB: 0.03 }), null); // mint miễn phí, chưa ai bán: không đoán giá
  assert.equal(mintCostBNB(NFT, [{ target: NFT, qty: '2', valueWei: parseEther('0.02').toString() }]), 0.01);
});

test('autoSellRun: chỉ chạy khi bật, bỏ NFT đã đăng, tối đa maxPerRun', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'as-'));
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    const report = { wallet: MAKER, holdings: [{ contract: NFT, name: 'Test', sales: { medianBNB: 0.05 }, items: [{ tokenId: '1' }, { tokenId: '2' }, { tokenId: '3' }] }] };
    const calls = [];
    const listFn = async (_p, _c, o) => { calls.push(o); return { orderId: 'x', priceBNB: o.priceBNB, receiveBNB: o.priceBNB * 0.93, url: 'u' }; };
    assert.deepEqual(await autoSellRun(null, cfg, report, { a: autoSellConfig(), listFn, log: () => {} }), []); // mặc định TẮT
    const a = saveAutoSell({ enabled: true, maxPerRun: 2, markupPct: 30 });
    assert.equal((await autoSellRun(null, cfg, report, { a, listFn, log: () => {} })).length, 2);
    assert.equal(calls[0].priceBNB, 0.05);
    // NFT #1, #2 đã đăng (listFn thật ghi data/listed.json; ở đây tự ghi) → lượt sau chỉ còn #3.
    const { markListed } = await import('../src/autosell.js');
    for (const id of ['1', '2']) markListed(`${NFT.toLowerCase()}:${id}`, { expiresAt: new Date(Date.now() + 86400_000).toISOString() });
    calls.length = 0;
    await autoSellRun(null, cfg, report, { a, listFn, log: () => {} });
    assert.deepEqual(calls.map((c) => c.tokenId), ['3']);
    assert.deepEqual(await autoSellRun(null, { ...cfg, elementKey: '' }, report, { a, listFn, log: () => {} }), []); // thiếu key
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lpLock: phân biệt LP đã đốt / nằm ở ví thường', async () => {
  const { lpLock } = await import('../src/lp.js');
  const { TOPIC } = await import('../src/chain.js');
  const { zeroPadValue } = await import('ethers');
  const TOKEN = '0x3333333333333333333333333333333333333333';
  const PAIR = '0x4444444444444444444444444444444444444444';
  const DEV = '0x000000000000000000000000000000000000d0d0';
  const I = new Interface(['function getPair(address,address) view returns (address)', 'function getPool(address,address,uint24) view returns (address)', 'function totalSupply() view returns (uint256)', 'function balanceOf(address) view returns (uint256)']);
  const mk = (bals) => ({
    getBlockNumber: async () => 1000,
    getCode: async () => '0x',
    getLogs: async () => Object.keys(bals).map((a) => ({ address: PAIR, topics: [TOPIC.TRANSFER, zeroPadValue(ZeroAddress, 32), zeroPadValue(a, 32)] })),
    async call({ data }) {
      const f = I.parseTransaction({ data });
      if (f.name === 'getPair') return coder.encode(['address'], [PAIR]);
      if (f.name === 'getPool') return coder.encode(['address'], [ZeroAddress]);
      if (f.name === 'totalSupply') return coder.encode(['uint256'], [1000n]);
      return coder.encode(['uint256'], [bals[f.args[0].toLowerCase()] ?? 0n]);
    },
  });
  const burned = await lpLock(mk({ '0x000000000000000000000000000000000000dead': 990n, [DEV]: 10n }), TOKEN);
  assert.equal(burned.verdict, 'burned');
  assert.equal(burned.burned, 99);
  const rug = await lpLock(mk({ [DEV]: 900n, '0x000000000000000000000000000000000000dead': 100n }), TOKEN);
  assert.equal(rug.verdict, 'unlocked');
  assert.match(rug.note, /90% LP/);
});

test('idsByOwnerScan: tìm số token qua ownerOf gộp Multicall3 khi hợp đồng không liệt kê được', async () => {
  const { idsByOwnerScan } = await import('../src/sell.js');
  const mc = new Interface(['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns ((bool success,bytes returnData)[])', 'function totalSupply() view returns (uint256)']);
  const own = new Interface(['function ownerOf(uint256) view returns (address)']);
  const OWNED = new Set([7n, 950n]);
  const provider = {
    async call({ to, data }) {
      if (data.startsWith(mc.getFunction('totalSupply').selector)) return coder.encode(['uint256'], [1000n]);
      const [calls] = mc.decodeFunctionData('aggregate3', data);
      return mc.encodeFunctionResult('aggregate3', [calls.map((c) => {
        const id = own.decodeFunctionData('ownerOf', c.callData)[0];
        return [true, coder.encode(['address'], [OWNED.has(id) ? MAKER : '0x000000000000000000000000000000000000bEEF'])];
      })]);
    },
  };
  assert.deepEqual(await idsByOwnerScan(provider, NFT, MAKER, 2), ['7', '950']);
  assert.deepEqual(await idsByOwnerScan(provider, NFT, MAKER, 1), ['7']);
});
