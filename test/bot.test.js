import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Interface, id, zeroPadValue, ZeroAddress, parseEther, AbiCoder } from 'ethers';
import { aggregateMints } from '../src/sources/onchain.js';
import { parseCreated, launchpadV2 } from '../src/sources/gang.js';
import { extractSignals } from '../src/sources/x.js';
import { scanBytecode, sel, guardCall, scoreRisk, inspectContract } from '../src/risk.js';
import { buildCall, mint, maxQty } from '../src/mint.js';
import { alphaScore } from '../src/scanner.js';
import { MultiRpc, isRpcError } from '../src/chain.js';
import { DEFAULTS } from '../src/config.js';
import { TOPIC } from '../src/chain.js';

process.env.BAW_BIN = new URL('./fake-baw.mjs', import.meta.url).pathname;
process.chdir(new URL('..', import.meta.url).pathname); // ledger ghi vào data/ của dự án
const pad = (a) => zeroPadValue(a, 32);
const NFT = '0x2222222222222222222222222222222222222222';
const A = '0x000000000000000000000000000000000000aaaa';
const B = '0x000000000000000000000000000000000000bbbb';
const coder = AbiCoder.defaultAbiCoder();

test('aggregateMints: đếm mint ERC-721/1155 từ address(0), bỏ qua ERC-20', () => {
  const logs = [
    { address: NFT, topics: [TOPIC.TRANSFER, TOPIC.ZERO, pad(A), pad('0x01')], blockNumber: 10, transactionHash: '0xa' },
    { address: NFT, topics: [TOPIC.TRANSFER, TOPIC.ZERO, pad(B), pad('0x02')], blockNumber: 12, transactionHash: '0xb' },
    { address: NFT, topics: [TOPIC.TRANSFER, TOPIC.ZERO, pad(A), pad('0x03')], blockNumber: 11, transactionHash: '0xc' },
    { address: B, topics: [TOPIC.TRANSFER, TOPIC.ZERO, pad(A)], blockNumber: 10, transactionHash: '0xd' }, // ERC-20
    { address: A, topics: [TOPIC.TRANSFER_SINGLE, pad(B), TOPIC.ZERO, pad(B)], blockNumber: 9, transactionHash: '0xe' },
  ];
  const rows = aggregateMints(logs);
  const nft = rows.find((r) => r.address === NFT);
  assert.equal(nft.mints, 3);
  assert.equal(nft.uniqueMinters, 2);
  assert.deepEqual([nft.firstBlock, nft.lastBlock], [10, 12]);
  assert.equal(rows.find((r) => r.standard === 'ERC1155').mints, 1);
  assert.equal(rows.length, 2);
});

test('parseCreated: đọc event Created của gang LaunchpadV2', () => {
  const ev = launchpadV2.getEvent('Created');
  const enc = launchpadV2.encodeEventLog(ev, [NFT, A, 'Agent Coin', 'AGC', '', false, ZeroAddress, ZeroAddress, 15n]);
  const [row] = parseCreated([{ ...enc, address: '0x1B8F3f69DFa0a7F63d308C7EB0Fd38D8b099966E', blockNumber: 5, transactionHash: '0x1' }]);
  assert.equal(row.symbol, 'AGC');
  assert.equal(row.kind, 'token');
});

test('extractSignals: lấy địa chỉ 0x từ tweet, gộp lượt nhắc', () => {
  const s = extractSignals([
    { text: `Agent ID mint live ${NFT} https://x.example/mint`, likes: 5 },
    { text: `打 ${NFT.toLowerCase()} 内盘`, reposts: 2 },
    { text: 'không có địa chỉ' },
  ]);
  assert.equal(s.length, 1);
  assert.equal(s[0].mentions, 2);
  assert.equal(s[0].engagement, 9);
});

test('scanBytecode: nhận PUSH4 selector và opcode nguy hiểm, bỏ qua dữ liệu PUSH', () => {
  const s = sel('mint(uint256)').slice(2);
  const code = '0x63' + s + '60ff' + 'f4'; // PUSH4 sel; PUSH1 0xff (dữ liệu, không phải SELFDESTRUCT); DELEGATECALL
  const r = scanBytecode(code);
  assert.ok(r.push4.has('0x' + s));
  assert.equal(r.hasSelfdestruct, false);
  assert.equal(r.hasDelegatecall, true);
});

test('guardCall: chặn setApprovalForAll / approve và vượt trần', () => {
  const nftI = new Interface(['function setApprovalForAll(address,bool)', 'function approve(address,uint256)']);
  const cap = parseEther('0.02');
  assert.match(guardCall({ to: NFT, target: NFT, data: nftI.encodeFunctionData('setApprovalForAll', [A, true]), valueWei: 0n, maxPerMintWei: cap })[0], /drainer/);
  assert.match(guardCall({ to: NFT, target: NFT, data: nftI.encodeFunctionData('approve', [A, 1n]), valueWei: 0n, maxPerMintWei: cap })[0], /drainer/);
  assert.match(guardCall({ to: NFT, target: NFT, data: sel('mint()'), valueWei: parseEther('0.5'), maxPerMintWei: cap })[0], /vượt trần/);
  assert.deepEqual(guardCall({ to: NFT, target: NFT, data: sel('mint()'), valueWei: 0n, maxPerMintWei: cap }), []);
});

test('scoreRisk: hợp đồng chưa verify + proxy bị trừ điểm nặng', () => {
  const r = scoreRisk({ hasCode: true, verified: false, isProxy: true, isNft: true, mintCandidates: ['mint()'] });
  assert.equal(r.score, 50);
  assert.equal(scoreRisk({ hasCode: false }).score, 0);
});

test('buildCall: mặc định qty=1 và người nhận là ví', () => {
  const r = buildCall({ fn: 'mint(address,uint256)', walletAddr: A });
  assert.equal(r.qty, 1n);
  assert.throws(() => buildCall({ fn: 'mint(bytes32[],uint256)', walletAddr: A }), /tham số đặc biệt/);
});

test('alphaScore: agent-only mint có điểm cao hơn', () => {
  assert.ok(alphaScore({ uniqueMinters: 50, agentRatio: 1 }) > alphaScore({ uniqueMinters: 50, agentRatio: 0 }));
});

// Provider giả: một NFT ERC-721 có mint(uint256) và price() = 0.005 BNB.
function fakeProvider({ price = parseEther('0.005'), revert = false } = {}) {
  const code = '0x63' + sel('mint(uint256)').slice(2) + '63' + sel('price()').slice(2) + '00';
  return {
    getBlockNumber: async () => 1000,
    getCode: async () => code,
    getStorage: async () => '0x' + '0'.repeat(64),
    estimateGas: async () => { if (revert) throw new Error('execution reverted: sold out'); return 90000n; },
    call: async ({ data, value = 0n }) => {
      if (data.startsWith(sel('mint(uint256)'))) {
        const qty = BigInt('0x' + data.slice(10));
        if (BigInt(value) < price * qty) throw new Error('execution reverted: insufficient value');
        return '0x';
      }
      if (data.startsWith(sel('supportsInterface(bytes4)'))) return coder.encode(['bool'], [data.includes('80ac58cd')]);
      if (data === sel('price()')) return coder.encode(['uint256'], [price]);
      if (data === sel('owner()')) return coder.encode(['address'], [A]);
      throw new Error('revert');
    },
  };
}
const cfg = { ...DEFAULTS, etherscanKey: '', walletAddress: '' };

test('inspectContract: tìm ra hàm mint và giá', async () => {
  const r = await inspectContract(fakeProvider(), NFT, cfg);
  assert.equal(r.standard, 'ERC721');
  assert.deepEqual(r.mintCandidates, ['mint(uint256)']);
  assert.equal(r.price.wei, parseEther('0.005'));
  assert.equal(r.score, 90); // -10 vì không có ETHERSCAN_API_KEY
});

test('mint dry-run: không gọi baw, trả về calldata', async () => {
  const r = await mint(fakeProvider(), cfg, NFT, {});
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'dry');
  assert.equal(r.valueWei, parseEther('0.005'));
});

test('mint --preview: đi qua baw giả, dừng trước execute', async () => {
  const r = await mint(fakeProvider(), cfg, NFT, { preview: true });
  assert.equal(r.ok, true);
  assert.equal(r.requestId, 'req-1');
});

test('mint --preview: chặn khi preview cho thấy cấp allowance', async () => {
  process.env.FAKE_AUTHORITY = '1';
  try {
    const r = await mint(fakeProvider(), cfg, NFT, { preview: true });
    assert.equal(r.reason, 'preview');
    assert.match(r.error, /cấp quyền/);
  } finally { delete process.env.FAKE_AUTHORITY; }
});

test('mint: từ chối khi giá vượt trần, và khi mô phỏng revert', async () => {
  assert.equal((await mint(fakeProvider({ price: parseEther('1') }), cfg, NFT, { preview: true })).reason, 'blocked');
  assert.match((await mint(fakeProvider(), cfg, NFT, { preview: true, qty: 50 })).errs[0], /Tối đa/);
  const r = await mint(fakeProvider({ revert: true }), cfg, NFT, { preview: true });
  assert.equal(r.reason, 'blocked');
  assert.match(r.errs[0], /Mô phỏng revert/);
});

test('buildCall: nút Mint 2 truyền số lượng 2', () => {
  assert.equal(buildCall({ fn: 'mint(uint256)', walletAddr: A, qty: 2n }).qty, 2n);
  assert.throws(() => buildCall({ fn: 'mint()', walletAddr: A, qty: 2n }), /chỉ mint được 1/);
});

test('maxQty: lấy nhỏ nhất giữa giới hạn/ví, còn lại, và trần chi tiêu', () => {
  const free = { price: { wei: 0n } };
  assert.equal(maxQty(free, cfg).max, 20); // dự án không công bố giới hạn
  assert.equal(maxQty({ ...free, maxPerWallet: 20n }, cfg).max, 20);
  assert.equal(maxQty({ ...free, maxPerWallet: 20n, walletMinted: 5n }, cfg).max, 15);
  assert.equal(maxQty({ ...free, maxPerWallet: 20n, maxPerTx: 10n }, cfg).max, 10);
  assert.equal(maxQty({ ...free, maxSupply: 100n, totalSupply: 99n }, cfg).max, 1);
  assert.equal(maxQty({ price: { wei: parseEther('0.02') }, maxPerWallet: 20n }, cfg).max, 2); // trần 0.05 BNB
  const usdt = { price: { wei: parseEther('3') }, payToken: { symbol: 'USDT', decimals: 18 }, maxPerWallet: 4n };
  assert.equal(maxQty(usdt, cfg, { bnbUsdt: 600 }).max, 4); // 4 x 3 USDT = 0.02 BNB
});

test('MultiRpc: RPC lỗi mạng thì tự chuyển, lỗi revert thì không', async () => {
  const made = [];
  const factory = (u) => { made.push(u); return {
    getBlockNumber: async () => { if (u === 'bad') throw Object.assign(new Error('fetch failed'), { code: 'NETWORK_ERROR' }); return 7; },
    getLogs: async () => [],
    call: async () => { throw Object.assign(new Error('execution reverted'), { code: 'CALL_EXCEPTION' }); },
  }; };
  const m = await new MultiRpc(['bad', 'good'], { factory }).init();
  assert.equal(m.url, 'good');
  assert.equal(await m.getBlockNumber(), 7);
  await assert.rejects(m.call({}), /reverted/);
  assert.equal(m.url, 'good');
  assert.equal(isRpcError({ message: 'limit exceeded' }), true);
});

import { salePriceBNB, toBNB } from '../src/sell.js';
test('salePriceBNB: BNB trực tiếp, WBNB/USDT trả cho người bán, chia theo số NFT', () => {
  const seller = '0x0000000000000000000000000000000000002001';
  assert.equal(salePriceBNB({ txValueWei: parseEther('0.2'), seller, nftCount: 2 }), 0.1);
  const log = (token, amt, to = seller) => ({ address: token, topics: [TOPIC.TRANSFER, pad(A), pad(to)], data: coder.encode(['uint256'], [amt]) });
  assert.equal(salePriceBNB({ txValueWei: 0n, seller, nftCount: 1, receiptLogs: [log('0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', parseEther('0.05'))] }), 0.05);
  assert.equal(salePriceBNB({ txValueWei: 0n, seller, nftCount: 1, bnbUsdt: 600, receiptLogs: [log('0x55d398326f99059fF775485246999027B3197955', parseEther('30'))] }), 0.05);
  assert.equal(salePriceBNB({ txValueWei: 0n, seller, nftCount: 1, receiptLogs: [log('0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', parseEther('1'), B)] }), null); // trả cho người khác
  assert.equal(toBNB('0.5'), 0.5);
  assert.equal(toBNB('500000000000000000'), 0.5);
});

import { mintPaidBNB } from '../src/sell.js';
import { guardApprove } from '../src/risk.js';
test('mintPaidBNB: free mint, trả BNB, trả USDT; chia theo số NFT; tính gas', () => {
  const minter = '0x0000000000000000000000000000000000001000';
  assert.deepEqual(mintPaidBNB({ txValueWei: 0n, minter, nftCount: 3 }), { priceBNB: 0, gasBNB: null, token: 'free' });
  assert.equal(mintPaidBNB({ txValueWei: parseEther('0.03'), minter, nftCount: 3 }).priceBNB, 0.01);
  const usdtLog = { address: '0x55d398326f99059fF775485246999027B3197955', topics: [TOPIC.TRANSFER, pad(minter), pad(B)], data: coder.encode(['uint256'], [parseEther('12')]) };
  const r = mintPaidBNB({ txValueWei: 0n, receiptLogs: [usdtLog], minter, nftCount: 4, bnbUsdt: 600, gasUsed: 100000n, gasPrice: 1000000000n });
  assert.equal(r.token, 'USDT');
  assert.ok(Math.abs(r.priceBNB - 0.005) < 1e-12);
  assert.equal(r.gasBNB, 0.000025);
});

test('guardApprove: chỉ cho approve đúng số tiền, đúng hợp đồng NFT, đúng stablecoin', () => {
  const USDT = '0x55d398326f99059fF775485246999027B3197955';
  assert.deepEqual(guardApprove({ token: USDT, spender: NFT, target: NFT, amount: 5n, expected: 5n }), []);
  assert.equal(guardApprove({ token: USDT, spender: A, target: NFT, amount: 5n, expected: 5n }).length, 1);
  assert.equal(guardApprove({ token: USDT, spender: NFT, target: NFT, amount: 2n ** 256n - 1n, expected: 5n }).length, 1);
  assert.equal(guardApprove({ token: A, spender: NFT, target: NFT, amount: 5n, expected: 5n }).length, 1);
});

import { baw } from '../src/baw.js';
test('baw: báo rõ khi chưa cài, chặn tham số có ký tự shell', () => {
  const old = process.env.BAW_BIN;
  delete process.env.BAW_BIN;
  process.env.PATH_BACKUP = process.env.PATH;
  process.env.PATH = '/nonexistent';
  try {
    assert.throws(() => baw(['wallet', 'status']), (e) => e.code === 'BAW_MISSING');
    assert.throws(() => baw(['approvals', 'revoke', '--spender', '0x1;rm']), /không hợp lệ/);
  } finally {
    process.env.PATH = process.env.PATH_BACKUP;
    process.env.BAW_BIN = old;
  }
});

import { isRangeError, getLogsChunked } from '../src/chain.js';
test('getLogs: lỗi "quá nhiều log" thì chia nhỏ đoạn, không đổi RPC', async () => {
  assert.equal(isRangeError(new Error('query returned more than 10000 results')), true);
  assert.equal(isRangeError(new Error('rate limit exceeded')), false);
  let calls = 0;
  const p = { getLogs: async ({ fromBlock, toBlock }) => { calls++; if (toBlock - fromBlock > 12) throw new Error('block range too large'); return [{ fromBlock }]; } };
  const logs = await getLogsChunked(p, {}, 0, 99, 50);
  assert.ok(logs.length >= 8);
  assert.ok(calls > 2);
});

test('MultiRpc: RPC không trả log thì lấy log qua RPC khác; bsc-dataseed chỉ dùng để đọc', async () => {
  const net = Object.assign(new Error('missing response'), { code: 'SERVER_ERROR' });
  const factory = (u) => ({
    getBlockNumber: async () => 1000,
    getLogs: async () => { if (u !== 'https://good-logs') throw net; return [{ u }]; },
  });
  const m = await new MultiRpc(['https://bsc-dataseed1.defibit.io', 'https://no-logs', 'https://good-logs'], { factory }).init();
  assert.equal(m.logsUrl, 'https://good-logs');
  assert.deepEqual(await m.getLogs({}), [{ u: 'https://good-logs' }]);
});

test('getLogs: RPC hỏng thì dừng sớm, không chia nhỏ ra hàng trăm yêu cầu', async () => {
  let calls = 0;
  const p = { getLogs: async () => { calls++; throw new Error('missing response'); } };
  await assert.rejects(getLogsChunked(p, {}, 0, 49_999, 50), /RPC không trả log/);
  assert.ok(calls < 20, `gọi ${calls} lần`);
});

import { receivedNfts } from '../src/sell.js';
import { rmSync } from 'node:fs';
test('NFT trong ví: quét lần đầu, lần sau chỉ quét block mới, nhớ kết quả', async () => {
  const W = '0x0000000000000000000000000000000000001234';
  const path = 'data/test-wallet-nfts.json';
  rmSync(path, { force: true });
  let head = 10_000;
  const asked = [];
  const p = {
    getBlockNumber: async () => head,
    getLogs: async ({ fromBlock, toBlock }) => {
      asked.push([fromBlock, toBlock]);
      return fromBlock <= 5000 && 5000 <= toBlock ? [{ address: NFT, topics: [TOPIC.TRANSFER, pad(A), pad(W), pad('0x07')], blockNumber: 5000 }] : [];
    },
  };
  const r1 = await receivedNfts(p, W, { blocks: 8000, chunk: 1000, cachePath: path });
  assert.deepEqual([...r1.get(NFT)], ['7']);
  asked.length = 0;
  head = 10_500;
  const r2 = await receivedNfts(p, W, { blocks: 8000, chunk: 1000, cachePath: path });
  assert.deepEqual([...r2.get(NFT)], ['7']);
  assert.deepEqual(asked, [[10_001, 10_500]]); // chỉ quét block mới
  rmSync(path, { force: true });
});

import { contractRules, extractRules, rulesFor, translateVi } from '../src/rules.js';
test('Luật NFT: đọc điều kiện từ bytecode, đọc mục Rules trên trang dự án, dịch', async () => {
  const str = (t) => '7f' + Buffer.concat([Buffer.from(t), Buffer.alloc(32 - t.length)]).toString('hex');
  const code = '0x' + str('Max per wallet reached') + '6000' + str('Mint not open') + str('Ownable: caller is not the') + '73' + '60b9262456de011f7d15a54cdd8c48baaa8b022f';
  const b = scanBytecode(code);
  const c = contractRules({ revertStrings: b.strings, usesAgentId: b.push20.has('0x60b9262456de011f7d15a54cdd8c48baaa8b022f'), errorNames: ['SoldOut'] });
  assert.ok(c.rules.some((r) => r.includes('mỗi ví')));
  assert.ok(c.rules.some((r) => r.includes('mở mint')));
  assert.ok(c.rules.some((r) => r.includes('tổng cung')));
  assert.ok(c.rules.some((r) => r.includes('Agent ID')));
  assert.ok(!c.untranslated.some((r) => r.includes('Ownable')));

  const html = '<h2>Four tiers</h2><p>x</p><h2>THE RULES</h2><ul><li>Supply 3,888: 3,000 public.</li><li>Up to <b>3</b> original mints per wallet.</li></ul><h2>Footer</h2><ul><li>ignore me please</li></ul>';
  assert.deepEqual(extractRules(html), ['Supply 3,888: 3,000 public.', 'Up to 3 original mints per wallet.']);

  const fakeFetch = async (u) => ({ json: async () => [[[`VI(${decodeURIComponent(new URL(u).searchParams.get('q'))})`]]] });
  assert.deepEqual(await translateVi(['Hello world', 'Đã là tiếng Việt'], fakeFetch), ['VI(Hello world)', 'Đã là tiếng Việt']);

  const r = rulesFor({ address: NFT, maxSupply: 3888n, totalSupply: 120n, maxPerWallet: 3n, usesAgentId: true, hasAgentId: false }, { priceText: 'miễn phí' });
  assert.ok(r.auto.some((x) => x.includes('Tổng cung')));
  assert.ok(r.auto.some((x) => x.includes('CHƯA có')));
});

import { approvalsList } from '../src/baw.js';
test('approvals: CLI không nhận --binanceChainId thì chạy lại không có, tự lọc BSC', () => {
  const r = approvalsList('56');
  assert.equal(r.data.list.length, 1);
  assert.equal(r.data.list[0].binanceChainId, '56');
});

import { holdingsOf } from '../src/sell.js';
import { watchList } from '../src/watch.js';
test('NFT trong ví: hợp đồng không liệt kê được (kiểu Sigil) vẫn tìm ra id qua log của riêng hợp đồng', async () => {
  const W = '0x07cFf333C712485b5cFFe6B77983b0514B608874';
  const SIG = '0xe397A4776F9e7cDC016C332b15756325E4AAc84B';
  assert.ok(watchList('data/none.json').includes(SIG)); // dự án đã biết luôn được kiểm tra
  const I = new Interface(['function balanceOf(address) view returns (uint256)', 'function ownerOf(uint256) view returns (address)', 'function name() view returns (string)']);
  const p = {
    getBlockNumber: async () => 129_374_218,
    getLogs: async (f) => {
      if (!f.address) throw new Error('server response 400 Bad Request'); // RPC từ chối log toàn mạng
      return f.fromBlock <= 129_374_188 && 129_374_188 <= f.toBlock ? [{ address: SIG, topics: [TOPIC.TRANSFER, TOPIC.ZERO, pad(W), pad('0x05')], blockNumber: 129_374_188 }] : [];
    },
    call: async ({ data }) => {
      const f = I.parseTransaction({ data })?.name;
      if (f === 'balanceOf') return coder.encode(['uint256'], [1n]);
      if (f === 'ownerOf') return coder.encode(['address'], [W]);
      if (f === 'name') return coder.encode(['string'], ['Xuanwu Sigil']);
      return '0x';
    },
  };
  const h = await holdingsOf(p, W, [SIG]);
  assert.equal(h.length, 1);
  assert.deepEqual(h[0].tokenIds, ['5']);
});

import { testRpc } from '../src/chain.js';
test('RPC riêng: chỉ nhận https, đúng chainId 56, phải lấy được log', async () => {
  const mk = (chainId, logsOk = true) => () => ({ send: async () => chainId, getBlockNumber: async () => 5000, getLogs: async () => { if (!logsOk) throw new Error('method not allowed'); return []; } });
  assert.equal((await testRpc('http://x.io', mk('0x38'))).ok, false);
  assert.match((await testRpc('https://x.io', mk('0x1'))).error, /chainId 1/);
  assert.match((await testRpc('https://x.io', mk('0x38', false))).error, /không dùng được/);
  assert.equal((await testRpc('https://x.io', mk('0x38'))).ok, true);
});

import { extractX } from '../src/rules.js';
test('Link X dự án: lấy từ trang web hoặc metadata, bỏ link chia sẻ', () => {
  assert.equal(extractX('<a href="https://twitter.com/intent/tweet?x">s</a> <a href="https://x.com/XuanwuPanel">x</a>'), 'https://x.com/XuanwuPanel');
  assert.equal(extractX('', { twitter: '@abc_1' }), 'https://x.com/abc_1');
  assert.equal(extractX('<a href="https://x.com/search?q=1">s</a>'), null);
});

test('MultiRpc: nhiều đoạn cùng lỗi chỉ đổi RPC 1 lần; RPC không tồn tại bị loại; RPC riêng luôn đứng đầu', async () => {
  const lines = [];
  const factory = (u) => ({
    getBlockNumber: async () => 1000,
    getLogs: async () => {
      if (u === 'https://dead') throw Object.assign(new Error('getaddrinfo ENOTFOUND dead'), { code: 'ENOTFOUND' });
      if (u === 'https://slow') { await new Promise((r) => setTimeout(r, 5)); throw new Error('missing response'); }
      return [{ u }];
    },
  });
  const m = new MultiRpc(['https://mine', 'https://slow', 'https://dead', 'https://ok'], { factory, log: (l) => lines.push(l), custom: 'https://mine' });
  m.logUrls = ['https://slow', 'https://dead', 'https://ok'];
  m.lp = factory('https://slow');
  const r = await Promise.all(Array.from({ length: 6 }, () => m.getLogs({})));
  assert.ok(r.every((x) => x[0].u === 'https://ok'));
  assert.ok(!m.logUrls.includes('https://dead'));
  assert.ok(lines.filter((l) => l.includes('lấy log qua')).length <= 3, lines.join('\n'));
});

import { idsFromTxs } from '../src/sell.js';
test('Bán NFT: lấy id NFT từ chính giao dịch mint qua bot', async () => {
  const W = '0x07cFf333C712485b5cFFe6B77983b0514B608874';
  const p = { getTransactionReceipt: async () => ({ logs: [
    { address: NFT, topics: [TOPIC.TRANSFER, TOPIC.ZERO, pad(W), pad('0x05')] },
    { address: NFT, topics: [TOPIC.TRANSFER, TOPIC.ZERO, pad(A), pad('0x06')] }, // người khác
  ] }) };
  const m = await idsFromTxs(p, W, [{ txHash: '0xabc' }, { target: NFT }]);
  assert.deepEqual([...m.get(NFT)], ['5']);
});

import { scanOnchainMints } from '../src/sources/onchain.js';
test('Hidden gem: NFT chỉ cho Agent ID mint chậm (3 ví) vẫn được tìm ra', async () => {
  const G = '0x2C7FbFad6D4709375883f5B57E3c871C96f0dc00';
  const I = new Interface(['function balanceOf(address) view returns (uint256)', 'function name() view returns (string)']);
  const m = (who, i) => ({ address: G, topics: [TOPIC.TRANSFER, TOPIC.ZERO, pad(who), pad(toHex(i))], blockNumber: 990, transactionHash: '0x' + String(i).padStart(64, '0'), index: 0 });
  const toHex = (i) => '0x' + i.toString(16).padStart(2, '0');
  const p = {
    getBlockNumber: async () => 1000,
    getLogs: async (f) => (f.topics[0] === TOPIC.TRANSFER && f.fromBlock <= 990 && 990 <= f.toBlock ? [m(A, 1), m(B, 2), m('0x000000000000000000000000000000000000cccc', 3)] : []),
    getCode: async () => '0x73' + '60b9262456de011f7d15a54cdd8c48baaa8b022f' + '00',
    call: async ({ data }) => (I.parseTransaction({ data }).name === 'name' ? coder.encode(['string'], ['AURYN Relic']) : coder.encode(['uint256'], [1n])),
  };
  const cfg = { scan: { ...DEFAULTS.scan, blocks: 100, rememberGems: false } };
  const rows = await scanOnchainMints(p, cfg, () => {});
  assert.equal(rows.length, 1);
  assert.equal(rows[0].gem, true);
  assert.equal(rows[0].name, 'AURYN Relic');
});

test('Giới hạn mỗi ví đọc từ trang dự án; hợp đồng trùng tên bị cảnh báo hàng nhái', async () => {
  const { parsePerWallet } = await import('../src/sitefacts.js');
  const { markLookalikes } = await import('../src/scanner.js');
  assert.equal(parsePerWallet('Mint with your Binance AI Agent wallet. Each wallet can mint up to 4 robots for life.'), 4);
  assert.equal(parsePerWallet('Max 3 per wallet'), 3);
  assert.equal(parsePerWallet('Limit of 2 NFTs per address'), 2);
  assert.equal(parsePerWallet('Mỗi ví tối đa 5 NFT'), 5);
  assert.equal(parsePerWallet('7,777 on-chain AI robots'), null);
  const list = markLookalikes([
    { address: '0xA', name: 'AIVY Robot', minted: '67' },
    { address: '0xB', name: 'AIVY  Robot', minted: '1027' },
    { address: '0xC', name: 'Other' },
  ]);
  assert.equal(list[0].lookalike.of, '0xB');
  assert.equal(list[1].lookalike, null);
  assert.deepEqual(list[1].twins, ['0xA']);
  assert.equal(list[2].lookalike, undefined);
});

test('Telegram: chọn NFT cần báo, định dạng tin, không báo lặp, không lộ token', async () => {
  const { formatAlert, pickAlerts, notifyScan, findChats } = await import('../src/telegram.js');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const nfts = [
    { address: '0xAAA', name: 'Hot <One>', hot: 70, risk: 90, priceBNB: 0.001, minted: '10', maxSupply: '100', uniqueMinters: 20, agentRatio: 1 },
    { address: '0xBBB', name: 'Quiet Gem', hot: 30, gem: true, risk: 80, priceBNB: 0 },
    { address: '0xCCC', name: 'Cold', hot: 20, risk: 90 },
    { address: '0xDDD', name: 'Scam', hot: 90, risk: 20 },
    { address: '0xEEE', name: 'Hot <One>', hot: 60, risk: 90, lookalike: { of: '0xAAA', minted: 10 } },
  ];
  const t = { minHot: 50, repeatHours: 6 };
  assert.deepEqual(pickAlerts(nfts, t).map((n) => n.address), ['0xAAA', '0xBBB', '0xEEE']);
  assert.deepEqual(pickAlerts(nfts, t, { '0xaaa': Date.now() }).map((n) => n.address), ['0xBBB', '0xEEE']);
  const msg = formatAlert(nfts[0], 'vi');
  assert.match(msg, /Hot &lt;One&gt;/);
  assert.match(msg, /Giá: <b>0.001 BNB<\/b>/);
  assert.match(formatAlert(nfts[4], 'en'), /POSSIBLE FAKE/);
  assert.match(formatAlert(nfts[1], 'zh'), /宝藏项目/);

  const sent = [];
  const fetchFn = async (url, opt) => {
    sent.push({ url, body: JSON.parse(opt.body) });
    return { status: 200, json: async () => ({ ok: true, result: url.endsWith('getUpdates') ? [{ message: { chat: { id: 42, first_name: 'H' } } }] : {} }) };
  };
  process.env.TELEGRAM_BOT_TOKEN = 'SECRET123'; process.env.TELEGRAM_CHAT_ID = '42';
  try {
    const sentPath = join(mkdtempSync(join(tmpdir(), 'tg-')), 'alerted.json');
    const logs = [];
    assert.equal(await notifyScan({ nfts }, {}, (m) => logs.push(m), { fetchFn, sentPath }), 3);
    assert.equal(sent.length, 3);
    assert.equal(sent[0].body.chat_id, '42');
    assert.equal(sent[0].body.parse_mode, 'HTML');
    assert.equal(await notifyScan({ nfts }, {}, () => {}, { fetchFn, sentPath }), 0); // đã báo rồi thì thôi
    assert.ok(!logs.join(' ').includes('SECRET123'));
    // Lỗi từ Telegram không làm lộ token
    const bad = async () => { throw new Error('connect fail https://api.telegram.org/botSECRET123/sendMessage'); };
    const errs = [];
    await notifyScan({ nfts: [{ ...nfts[0], address: '0xFFF' }] }, {}, (m) => errs.push(m), { fetchFn: bad, sentPath });
    assert.ok(errs.length && !errs.join(' ').includes('SECRET123'), errs.join());
    assert.deepEqual(await findChats('SECRET123', fetchFn), [{ id: '42', name: 'H' }]);
  } finally {
    delete process.env.TELEGRAM_BOT_TOKEN; delete process.env.TELEGRAM_CHAT_ID;
  }
});
