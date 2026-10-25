import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Interface, Wallet, ZeroAddress, parseEther, AbiCoder, TypedDataEncoder } from 'ethers';
import { suggestPrice, mintCostBNB } from '../src/listed.js';

process.env.BAW_BIN = new URL('./fake-baw.mjs', import.meta.url).pathname;
const KEY = Wallet.createRandom();
process.env.FAKE_SIGN_KEY = KEY.privateKey;
const MAKER = KEY.address;
const NFT = '0x2222222222222222222222222222222222222222';
const coder = AbiCoder.defaultAbiCoder();

test('suggestPrice: lấy cao nhất trong trung vị / giá mint + lời / giá sàn; không có dữ liệu thì không đăng', () => {
  const a = { markupPct: 30, minPriceBNB: 0 };
  assert.equal(suggestPrice({ medianBNB: 0.05, costBNB: 0.01 }, a), 0.05);
  assert.equal(suggestPrice({ medianBNB: 0.01, costBNB: 0.02 }, a), 0.026);
  assert.equal(suggestPrice({ medianBNB: null, costBNB: null }, a), null);
  assert.equal(suggestPrice({ medianBNB: 0.01 }, { markupPct: 0, minPriceBNB: 0.03 }), 0.03);
  assert.equal(suggestPrice({ costBNB: 0 }, { markupPct: 30, minPriceBNB: 0.03 }), null); // mint miễn phí, chưa ai bán: không đoán giá
  assert.equal(suggestPrice({ medianBNB: 0.002, floorBNB: 0.004 }, { markupPct: 0, minPriceBNB: 0 }), 0.004); // không rao rẻ hơn giá sàn của chợ riêng
  assert.equal(mintCostBNB(NFT, [{ target: NFT, qty: '2', valueWei: parseEther('0.02').toString() }]), 0.01);
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

test('marketAsks: giá rao rẻ nhất trên chợ riêng, bỏ lệnh đã gỡ / hết hạn / người rao đã bán / chợ chưa có quyền', async () => {
  const { marketAsks } = await import('../src/refprice.js');
  const { zeroPadValue, parseEther: pe, Interface: I } = await import('ethers');
  const MK = '0xC6cBc2C06ae66d201A761FAa8Ac48aD92B835704';
  const COLL = '0xC4605C6A7765138784B3ca6F9a88e1c249a0d21f';
  const A = '0x1111111111111111111111111111111111111111', B = '0x2222222222222222222222222222222222222222', C = '0x3333333333333333333333333333333333333333';
  const W = (v) => BigInt(v).toString(16).padStart(64, '0');
  const T = '0x5b886b3c15d339ca3333d6712726a9665b4ded99f69cce925f48e03f1e891dcd';
  const ev = (blk, id, who, price, exp = 1795510242) => ({ address: MK, blockNumber: blk, transactionHash: '0x' + blk, topics: [T, zeroPadValue('0x' + id.toString(16).padStart(2, '0'), 32), zeroPadValue(who, 32)], data: price == null ? '0x' : '0x' + W(pe(price)) + W(exp) });
  const logs = [
    ev(900, 1, A, '0.003'),           // hợp lệ, rẻ nhất
    ev(901, 2, B, '0.001'),           // B đã bán NFT #2 cho người khác: bỏ
    ev(902, 3, C, '0.002'), ev(903, 3, C, null), // đã gỡ lệnh
    ev(904, 4, A, '0.0005', 1700000000), // hết hạn
    ev(905, 5, B, '0.0045'),          // chợ chưa có quyền NFT #5: bỏ
    ev(906, 6, C, '0.006'),           // hợp lệ (quyền cả bộ)
  ];
  const nft = new I(['function ownerOf(uint256) view returns (address)', 'function getApproved(uint256) view returns (address)', 'function isApprovedForAll(address,address) view returns (bool)']);
  const owner = { 1: A, 2: C, 5: B, 6: C };
  const p = {
    getBlockNumber: async () => 1000,
    getCode: async () => '0x6080' + COLL.slice(2).toLowerCase(),
    getLogs: async () => logs,
    call: async ({ to, data }) => {
      if (to.toLowerCase() !== COLL.toLowerCase()) throw new Error('no multicall');
      const d = nft.parseTransaction({ data });
      if (d.name === 'ownerOf') return nft.encodeFunctionResult('ownerOf', [owner[Number(d.args[0])] ?? A]);
      if (d.name === 'getApproved') return nft.encodeFunctionResult('getApproved', [Number(d.args[0]) === 1 ? MK : ZeroAddress]);
      return nft.encodeFunctionResult('isApprovedForAll', [d.args[0].toLowerCase() === C.toLowerCase()]);
    },
  };
  const r = await marketAsks(p, MK, COLL, { now: Date.parse('2026-10-25T00:00:00Z') });
  assert.equal(r.count, 2);
  assert.equal(r.floorBNB, 0.003);
  assert.deepEqual(r.asks.map((x) => x.tokenId), ['1', '6']);
  const mine = await marketAsks(p, MK, COLL, { now: Date.parse('2026-10-25T00:00:00Z'), exclude: A });
  assert.equal(mine.floorBNB, 0.006); // không tính lệnh của chính ví bạn
});

test('webPrices: đọc giá có nhãn trên web dự án (Floor / Price / Giá / JSON nhúng), bỏ số không có nhãn', async () => {
  const { webPrices } = await import('../src/refprice.js');
  const html = '<div>Floor Price <span>0.0042 BNB</span></div><p>Giá: 0,01 BNB</p><p>Supply 5000 · 3 BNB pool</p><script>x</script>'
    + '<script id="__NEXT_DATA__">{"floorPrice":"5000000000000000"}</script>';
  const r = webPrices(html);
  assert.deepEqual(r.map((x) => [x.kind, x.priceBNB]), [['floor', 0.0042], ['price', 0.01], ['floor', 0.005]]);
});

test('Ví: lỗi tạm của Binance không làm báo Developer Mode tắt; hết phiên thật mới coi là đăng xuất', async () => {
  const w = await import('../src/baw.js');
  assert.equal(w.devModeEnabled(), true);
  assert.equal(w.devModeInfo().inactiveSignOutAt, '2026-10-25T16:00:00.000Z');
  process.env.FAKE_SETTINGS = 'fail';
  assert.equal(w.devModeEnabled(), null); // chưa đọc được: không chặn mint
  assert.throws(() => w.devModeInfo(), (e) => e.auth === false);
  process.env.FAKE_SETTINGS = 'expired';
  assert.throws(() => w.devModeInfo(), (e) => e.auth === true);
  delete process.env.FAKE_SETTINGS;
  assert.equal(w.isAuthError({ code: 10003002 }), true);
  assert.equal(w.isAuthError({ code: 1001001, name: 'UNKNOWN_ERROR' }), false);
});

