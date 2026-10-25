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

test('findMarkets: nhận ra hợp đồng chợ từ giao dịch chuyển NFT, bỏ chuyển thẳng giữa 2 ví', async () => {
  const { findMarkets } = await import('../src/markets.js');
  const { TOPIC } = await import('../src/chain.js');
  const { zeroPadValue } = await import('ethers');
  const MARKET = '0x5555555555555555555555555555555555555555';
  const NFT2 = '0x6666666666666666666666666666666666666666';
  const log = (i, from) => ({ address: NFT2, transactionHash: '0x' + String(i).padStart(64, '0'), blockNumber: 100 + i, topics: [TOPIC.TRANSFER, zeroPadValue(from, 32), zeroPadValue(MAKER, 32), zeroPadValue('0x' + i.toString(16).padStart(2, '0'), 32)] });
  const sellers = ['0x00000000000000000000000000000000000000a1', '0x00000000000000000000000000000000000000a2', '0x00000000000000000000000000000000000000a3'];
  const logs = [log(1, sellers[0]), log(2, sellers[1]), log(3, sellers[2]), log(4, sellers[0])];
  const provider = {
    getBlockNumber: async () => 1000,
    getLogs: async () => logs,
    getCode: async (a) => (a.toLowerCase() === MARKET ? '0x6080' : '0x'),
    call: async () => '0x',
    getTransaction: async (h) => ({ from: sellers[0], value: 0n, to: h.endsWith('4') ? NFT2 : MARKET, data: h.endsWith('4') ? '0x23b872dd' + '00'.repeat(96) : '0xabcdef01' + '00'.repeat(64) }),
  };
  const r = await findMarkets(provider, NFT2, { fetchFn: async () => ({ ok: false }) });
  assert.equal(r.length, 1);
  assert.equal(r[0].address.toLowerCase(), MARKET);
  assert.equal(r[0].sales, 3);
  assert.equal(r[0].sellers, 3);
});

test('trustOf: chỉ tin chợ có cùng chủ (owner) với hợp đồng NFT; adaptSell thay đúng số token + ví', async () => {
  const { trustOf, adaptSell } = await import('../src/markets.js');
  const OI = new Interface(['function owner() view returns (address)']);
  const TEAM = '0x00000000000000000000000000000000000000c1';
  const owners = (m) => ({ call: async ({ to }) => coder.encode(['address'], [m[to.toLowerCase()] ?? m[to] ?? ZeroAddress]) });
  const MK = '0x7777777777777777777777777777777777777777';
  assert.equal((await trustOf(owners({ [NFT]: TEAM, [MK]: TEAM }), NFT, MK)).why, 'same-owner');
  assert.equal(await trustOf(owners({ [NFT]: TEAM, [MK]: '0x00000000000000000000000000000000000000d1' }), NFT, MK), null); // khác chủ: drainer / chợ lạ
  assert.equal(await trustOf(owners({}), NFT, MK), null); // cả hai đã bỏ quyền chủ (0x0): không đủ bằng chứng
  const seller = '0x00000000000000000000000000000000000000a1';
  const sel = '0x12345678';
  const sample = { seller, tokenId: '20', data: sel + [5n, 20n].map((v) => v.toString(16).padStart(64, '0')).join('') + seller.slice(2).padStart(64, '0') };
  const out = adaptSell(sample, { me: MAKER, tokenId: '3167' });
  assert.equal(out, sel + (5n).toString(16).padStart(64, '0') + (3167n).toString(16).padStart(64, '0') + MAKER.toLowerCase().slice(2).padStart(64, '0'));
  // Số token xuất hiện 2 lần: không chắc vị trí, bỏ.
  assert.equal(adaptSell({ ...sample, data: sel + [20n, 20n].map((v) => v.toString(16).padStart(64, '0')).join('') }, { me: MAKER, tokenId: '1' }), null);
});

test('learnMarket: học "đặt giá bán" và "bán vào lệnh mua" từ log của chợ; adaptList thay số token + giá + ví', async () => {
  const { learnMarket, adaptList } = await import('../src/markets.js');
  const { TOPIC } = await import('../src/chain.js');
  const { zeroPadValue, parseEther: pe } = await import('ethers');
  const MK = '0x8888888888888888888888888888888888888888';
  const COL = '0x9999999999999999999999999999999999999999';
  const W = (v) => BigInt(v).toString(16).padStart(64, '0');
  const A = (a) => a.slice(2).toLowerCase().padStart(64, '0');
  const LISTER = '0x00000000000000000000000000000000000000b1';
  const SELLER = '0x00000000000000000000000000000000000000b2';
  const BUYER = '0x00000000000000000000000000000000000000b3';
  const listData = '0xaaaaaaaa' + A(COL) + W(44) + W(pe('0.002'));
  const sellData = '0xbbbbbbbb' + W(1) + W(20);
  const txs = {
    ['0x' + '1'.padStart(64, '0')]: { tx: { from: LISTER, to: MK, value: 0n, data: listData }, rc: { status: 1, logs: [{ address: MK, topics: ['0x' + 'e'.repeat(64), zeroPadValue(LISTER, 32)], data: '0x' + W(44) + W(pe('0.002')) }] } },
    ['0x' + '2'.padStart(64, '0')]: { tx: { from: SELLER, to: MK, value: 0n, data: sellData }, rc: { status: 1, logs: [{ address: COL, topics: [TOPIC.TRANSFER, zeroPadValue(SELLER, 32), zeroPadValue(BUYER, 32), '0x' + W(20)], data: '0x' }] } },
  };
  const provider = {
    getBlockNumber: async () => 1000,
    getLogs: async () => Object.keys(txs).map((h, i) => ({ address: MK, transactionHash: h, blockNumber: 900 + i, topics: [], data: '0x' })),
    getTransaction: async (h) => txs[h].tx,
    getTransactionReceipt: async (h) => txs[h].rc,
  };
  const v = await learnMarket(provider, MK, COL);
  assert.equal(v.listSamples.length, 1);
  assert.equal(v.listSamples[0].tokenId, '44');
  assert.equal(v.listSamples[0].priceWei, pe('0.002').toString());
  assert.equal(v.sellSamples.length, 1);
  assert.equal(v.sellSamples[0].tokenId, '20');
  const out = adaptList(v.listSamples[0], { me: MAKER, tokenId: 3167n, priceWei: pe('0.005') });
  assert.equal(out, '0xaaaaaaaa' + A(COL) + W(3167) + W(pe('0.005')));
});

test('sellReport: RPC lỗi lần này thì dùng lại giá bán + chợ của lần trước, không báo "chưa ai bán"', async () => {
  const { sellReport } = await import('../src/sell.js');
  const { writeFileSync, mkdtempSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'sc-'));
  const C = '0x2D70000000000000000000000000000000003103';
  const path = join(dir, 'sell-cache.json');
  writeFileSync(path, JSON.stringify({ [C.toLowerCase()]: { at: Date.now() - 3600_000, sales: { count: 4, maxBNB: 0.001, medianBNB: 0.001 }, markets: [{ address: '0x149b000000000000000000000000000000004887', sales: 4, sellers: 4 }] } }));
  const I = new Interface(['function balanceOf(address) view returns (uint256)', 'function tokenOfOwnerByIndex(address,uint256) view returns (uint256)', 'function name() view returns (string)']);
  const provider = {
    getBlockNumber: async () => 1_000_000,
    getLogs: async () => { throw new Error('rate limited'); },
    getCode: async () => '0x',
    async call({ data }) {
      const f = (() => { try { return I.parseTransaction({ data }); } catch { return null; } })();
      if (f?.name === 'balanceOf') return coder.encode(['uint256'], [1n]);
      if (f?.name === 'tokenOfOwnerByIndex') return coder.encode(['uint256'], [3167n]);
      if (f?.name === 'name') return coder.encode(['string'], ['Agent Nakamigos Id']);
      throw new Error('revert');
    },
  };
  const r = await sellReport(provider, { scan: {} }, MAKER, [C], { cachePath: join(dir, 'w.json'), sellCachePath: path });
  const h = r.holdings[0];
  assert.equal(h.sales.count, 4);
  assert.ok(h.salesCached);
  assert.equal(h.markets.length, 1);
  assert.equal(h.items[0].best.priceBNB, 0.001);
  rmSync(dir, { recursive: true, force: true });
});

test('Chợ có người mua thật: ≥5 người mua trả BNB cho ≥5 người bán → tin, chỉ cấp quyền 1 NFT', async () => {
  const { findMarkets, approveTokenData } = await import('../src/markets.js');
  const { TOPIC } = await import('../src/chain.js');
  const { zeroPadValue } = await import('ethers');
  const MK = '0x5555555555555555555555555555555555555556';
  const COL = '0x6666666666666666666666666666666666666667';
  const a = (p, i) => '0x' + p + String(i).padStart(38, '0');
  const logs = [];
  const txs = {};
  for (let i = 1; i <= 6; i++) {
    const h = '0x' + String(i).padStart(64, '0');
    logs.push({ address: COL, transactionHash: h, blockNumber: 100 + i, topics: [TOPIC.TRANSFER, zeroPadValue(a('a1', i), 32), zeroPadValue(a('b1', i), 32), zeroPadValue('0x0' + i, 32)] });
    txs[h] = { from: a('b1', i), to: MK, value: 10n ** 15n, data: '0xabcdef01' + '00'.repeat(64) };
  }
  const provider = { getBlockNumber: async () => 1000, getLogs: async () => logs, getCode: async () => '0x6080', call: async () => '0x', getTransaction: async (h) => txs[h] };
  const [m] = await findMarkets(provider, COL, { fetchFn: async () => ({ ok: false }) });
  assert.equal(m.buyers, 6);
  assert.equal(m.trust.why, 'buyers');
  assert.equal(m.trust.scope, 'token');
  // Drainer: không ai trả BNB (value 0, kẻ gửi giao dịch nhận NFT của người khác) → không tin.
  for (const h in txs) txs[h] = { ...txs[h], value: 0n };
  const [d] = await findMarkets(provider, '0x6666666666666666666666666666666666666668', { logs: logs.map((l) => ({ ...l, address: '0x6666666666666666666666666666666666666668' })), fetchFn: async () => ({ ok: false }) });
  assert.equal(d.trust, null);
  assert.ok(approveTokenData(MK, 7).startsWith('0x095ea7b3'));
});

test('siteMentions: web dự án ghi địa chỉ chợ (trong HTML hoặc file JS cùng tên miền)', async () => {
  const { siteMentions } = await import('../src/markets.js');
  const MK = '0xAbCd000000000000000000000000000000001234';
  assert.equal(await siteMentions('https://proj.xyz/', `<div data-m="${MK.toLowerCase()}">`, MK), true);
  const html = '<script src="/assets/app.js"></script><script src="https://evil.com/x.js"></script>';
  const seen = [];
  const fetchFn = async (u) => { seen.push(u); return { ok: true, text: async () => (u.includes('proj.xyz') ? `const MARKET="${MK}"` : '') }; };
  assert.equal(await siteMentions('https://proj.xyz/', html, MK, fetchFn), true);
  assert.ok(!seen.some((u) => u.includes('evil.com')));
  assert.equal(await siteMentions('https://proj.xyz/', '<p>nothing</p>', MK, fetchFn), false);
});

test('Chợ chỉ bán 1 bộ NFT: học đặt giá không cần địa chỉ NFT; chưa có mẫu thì thử hàm list(uint256,uint256) có trong mã chợ', async () => {
  const { learnMarket, guessListCall } = await import('../src/markets.js');
  const { zeroPadValue, parseEther: pe, Interface: I } = await import('ethers');
  const MK = '0x8888888888888888888888888888888888888889';
  const COL = '0x9999999999999999999999999999999999999998';
  const W = (v) => BigInt(v).toString(16).padStart(64, '0');
  const LISTER = '0x00000000000000000000000000000000000000b1';
  const listData = '0xaaaaaaaa' + W(44) + W(pe('0.001'));
  const h = '0x' + '1'.padStart(64, '0');
  const sel = new I(['function list(uint256,uint256)']).getFunction('list').selector.slice(2);
  const provider = {
    getBlockNumber: async () => 1000,
    getLogs: async () => [{ address: MK, transactionHash: h, blockNumber: 999, topics: [], data: '0x' }],
    getCode: async () => '0x6080' + COL.slice(2).toLowerCase() + '63' + sel,
    call: async () => '0x',
    getTransaction: async () => ({ from: LISTER, to: MK, value: 0n, data: listData }),
    getTransactionReceipt: async () => ({ status: 1, logs: [{ address: MK, topics: ['0x' + 'e'.repeat(64), zeroPadValue(LISTER, 32)], data: '0x' + W(44) + W(pe('0.001')) }] }),
  };
  const v = await learnMarket(provider, MK, COL);
  assert.equal(v.single, true);
  assert.equal(v.listSamples.length, 1);
  const g = await guessListCall(provider, MK, COL, { me: MAKER, tokenId: 5888, priceWei: pe('0.002'), single: true });
  assert.equal(g.guessed, 'list(uint256,uint256)');
  assert.equal(g.data, '0x' + sel + W(5888) + W(pe('0.002')));
});

test('marketApproved perToken: quyền cả bộ không đủ, cần approve(chợ, số token)', async () => {
  const { marketApproved } = await import('../src/markets.js');
  const I = new Interface(['function isApprovedForAll(address,address) view returns (bool)', 'function getApproved(uint256) view returns (address)']);
  const MK = '0x7777777777777777777777777777777777777777';
  const p = (approvedTo) => ({ call: async ({ data }) => (I.parseTransaction({ data }).name === 'isApprovedForAll' ? coder.encode(['bool'], [true]) : coder.encode(['address'], [approvedTo])) });
  assert.equal(await marketApproved(p(ZeroAddress), NFT, MAKER, MK, 1), true);
  assert.equal(await marketApproved(p(ZeroAddress), NFT, MAKER, MK, 1, { perToken: true }), false);
  assert.equal(await marketApproved(p(MK), NFT, MAKER, MK, 1, { perToken: true }), true);
});

test('onchainListings: đọc lệnh rao bán của ví từ sự kiện chợ (Listed tokenId, seller, price, expiresAt)', async () => {
  const { onchainListings } = await import('../src/markets.js');
  const { zeroPadValue, parseEther: pe } = await import('ethers');
  const MK = '0xC6cBc2C06ae66d201A761FAa8Ac48aD92B835704';
  const W = (v) => BigInt(v).toString(16).padStart(64, '0');
  const p = { getBlockNumber: async () => 1000, getLogs: async () => [{ address: MK, blockNumber: 990, transactionHash: '0xabc', topics: ['0x5b886b3c15d339ca3333d6712726a9665b4ded99f69cce925f48e03f1e891dcd', zeroPadValue('0x0dc3', 32), zeroPadValue(MAKER, 32)], data: '0x' + W(pe('0.004')) + W(1795510242) }] };
  const m = await onchainListings(p, MK, MAKER);
  assert.equal(m.get('3523').priceBNB, 0.004);
  assert.equal(m.get('3523').expiresAt, '2026-11-24T08:50:42.000Z');
});
