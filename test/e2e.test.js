// Chạy server thật + node BSC giả + baw giả: quét → bấm Mint 2 → xác nhận.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeRpc, NFT, NFT_USDT, SIGIL, AURYN, GEARZ } from './fake-rpc.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = 38777;
const BASE = `http://127.0.0.1:${PORT}`;
const post = (p, body, origin = BASE) => fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body) }).then((r) => r.json());

test('giao diện web: quét, xem giá/giới hạn, Mint 2 có xác nhận', async (t) => {
  const rpc = await startFakeRpc(38545);
  const cwd = mkdtempSync(join(tmpdir(), 'nftbot-'));
  const srv = spawn(process.execPath, [join(ROOT, 'src/server.js')], {
    cwd, env: { ...process.env, PORT: String(PORT), NO_OPEN: '1', BSC_RPC_URL: 'http://127.0.0.1:38545', BAW_BIN: join(ROOT, 'test/fake-baw.mjs'), BNB_PRICE_SOURCE: 'onchain', FAKE_FETCH: JSON.stringify({ 'https://robots.example.com/': '<nav><a href="/market">Market</a></nav><p>Floor price: 0.04 BNB</p>' }) },
  });
  let out = '';
  srv.stdout.on('data', (d) => (out += d));
  srv.stderr.on('data', (d) => (out += d));
  t.after(() => { srv.kill(); rpc.close(); });

  let state;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 250));
    state = await fetch(BASE + '/api/state').then((r) => r.json()).catch(() => null);
    if (state?.scan && !state.scan.partial) break;
  }
  assert.ok(state?.scan, 'scan không xong:\n' + out);
  const n = state.scan.nfts.find((x) => x.address.toLowerCase() === NFT);
  assert.ok(n, JSON.stringify(state.scan));
  // Chỉ giữ NFT có web + chợ trên web; giá ghi trên web hiện để tham khảo.
  assert.equal(n.market.ok, true);
  assert.equal(n.market.url, 'https://robots.example.com/market');
  assert.equal(n.ref.web[0].prices[0].priceBNB, 0.04);
  assert.ok(!state.scan.nfts.some((x) => !x.market?.ok));
  assert.equal(n.priceBNB, 0.005);
  assert.equal(n.maxPerWallet, '2');
  assert.equal(n.maxQty, 2);
  // Giá người khác đang trả (đọc từ giao dịch mint) + giá bán + lãi ước tính.
  assert.equal(n.paid.priceBNB, 0.005);
  assert.equal(n.paid.free, false);
  assert.ok(n.paid.gasBNB > 0);
  assert.equal(n.sales.medianBNB, 0.03);
  assert.ok(Math.abs(n.profitBNB - (0.03 - 0.005 - n.paid.gasBNB)) < 1e-12);
  assert.equal(n.agentRatio, 1);
  assert.equal(n.uniqueMinters, 20);

  const html = await fetch(BASE + '/').then((r) => r.text());
  assert.match(html, /data-mint/);

  // Trang web lạ không gọi được API.
  assert.equal((await post('/api/preview', { address: NFT, qty: 1 }, 'https://evil.example')).error, 'origin bị chặn');

  const wallet = await fetch(BASE + '/api/wallet').then((r) => r.json());
  assert.equal(wallet.connected, true);
  assert.equal(wallet.installed, true);

  // Đăng nhập: hiện mã ghép đôi, auth verify chạy nền rồi báo xong.
  const login = await post('/api/login', {});
  assert.equal(login.pairingCode, '654321');
  let lw;
  for (let i = 0; i < 20 && !lw?.login?.done; i++) { await new Promise((r) => setTimeout(r, 100)); lw = await fetch(BASE + '/api/wallet').then((r) => r.json()); }
  assert.equal(lw.login.done, true);

  // Quyền đã cấp + revoke (chặn tham số bậy).
  const ap = await fetch(BASE + '/api/approvals').then((r) => r.json());
  assert.equal(ap.list[0].amount, 'unlimited');
  const rv = await post('/api/revoke', { tokenContract: ap.list[0].tokenContract, spender: ap.list[0].spender, type: 'approve' });
  assert.equal(rv.status, 'BROADCASTED');
  assert.equal((await post('/api/revoke', { tokenContract: '0x1; rm -rf /', spender: ap.list[0].spender, type: 'approve' })).ok, false);

  const pv = await post('/api/preview', { address: NFT, qty: 2 });
  assert.equal(pv.ok, true, JSON.stringify(pv));
  assert.deepEqual(pv.cost, { amount: '0.01', symbol: 'BNB' });
  assert.equal(pv.qty, '2');
  assert.equal(pv.step, 'mint');
  // Vượt giới hạn mỗi ví (2) thì bị từ chối.
  assert.match((await post('/api/preview', { address: NFT, qty: 3 })).error, /Tối đa 2/);

  const ex = await post('/api/execute', { id: pv.id });
  assert.equal(ex.ok, true);
  assert.equal(ex.status, 'BROADCASTED');
  assert.equal(ex.confirmed, true); // đã chờ giao dịch vào block
  // Mỗi preview chỉ execute được 1 lần.
  assert.equal((await post('/api/execute', { id: pv.id })).ok, false);

  const after = await fetch(BASE + '/api/state').then((r) => r.json());
  assert.equal(after.spentTodayBNB, '0.01');
  assert.equal(after.bnbUsdt, 600); // từ pool PancakeSwap giả
  assert.ok(after.lastScanMs >= 0);
  assert.ok(after.scan.durationMs >= 0);

  const bal = await fetch(BASE + '/api/balance').then((r) => r.json());
  assert.equal(bal.ok, true);
  assert.equal(bal.tokens[0].symbol, 'USDT');
  assert.ok(Math.abs(bal.totalUsd - 44.1) < 1e-9);

  // Bán: ví giữ NFT #7, giá cao nhất gần đây là giao dịch trả 0.05 WBNB.
  const sell = await post('/api/sell', {});
  assert.equal(sell.ok, true, JSON.stringify(sell));
  const h = sell.holdings.find((x) => x.contract.toLowerCase() === NFT);
  assert.deepEqual(h.tokenIds, ['7']);
  assert.equal(h.sales.count, 4);
  assert.equal(h.items[0].best.priceBNB, 0.05);
  assert.equal(h.sales.medianBNB, 0.03);
  // Tự tìm NFT ví đã nhận dù không có trong danh sách: Sigil #9 còn giữ, #8 đã chuyển đi.
  const hs = sell.holdings.find((x) => x.contract.toLowerCase() === SIGIL);
  assert.deepEqual(hs?.tokenIds, ['9']);

  // NFT trả bằng USDT: bước 1 approve đúng 12 USDT (4 x 3), bước 2 mint.
  const info = await post('/api/inspect', { address: NFT_USDT });
  assert.equal(info.payToken, 'USDT');
  assert.equal(info.maxQty, 4);
  const s1 = await post('/api/preview', { address: NFT_USDT, qty: 4 });
  assert.equal(s1.step, 'approve', JSON.stringify(s1));
  assert.deepEqual(s1.cost, { amount: '12.0', symbol: 'USDT' });
  const e1 = await post('/api/execute', { id: s1.id });
  assert.equal(e1.next, 'mint', JSON.stringify(e1));
  const s2 = await post('/api/preview', { address: NFT_USDT, qty: 4 });
  assert.equal(s2.step, 'mint', JSON.stringify(s2));
  assert.equal((await post('/api/execute', { id: s2.id })).ok, true);

  // Kiểu Xuanwu Sigil: mint() không tham số, không khai ERC165, giá lần này dò được = 0.0016 BNB.
  const sg = await post('/api/inspect', { address: SIGIL });
  assert.equal(sg.standard, 'ERC721');
  assert.equal(sg.mintFn, 'mint()');
  assert.equal(sg.mintTakesQty, false);
  assert.equal(sg.hasAgentId, true);
  assert.equal(sg.maxQty, 2); // 3 mỗi ví, đã mint 1
  const sp = await post('/api/preview', { address: SIGIL, qty: 1 });
  assert.equal(sp.ok, true, JSON.stringify(sp));
  assert.deepEqual(sp.cost, { amount: '0.0016', symbol: 'BNB' });

  // Kiểu AURYN: mint(agentTokenId, số lượng), giá từ quote(). Chưa nhập Agent ID thì báo; nhập đúng thì mint được.
  const au = await post('/api/inspect', { address: AURYN });
  assert.equal(au.agentMint, true);
  assert.equal(au.mintFn, 'mint(uint256,uint256)');
  assert.equal((await post('/api/preview', { address: AURYN, qty: 2 })).ok, false);
  assert.equal((await post('/api/agent', { name: 'khongco.ai' })).ok, false);
  const ag = await post('/api/agent', { name: 'tester.ai' });
  assert.equal(ag.ok, true, JSON.stringify(ag));
  const au2 = await post('/api/inspect', { address: AURYN });
  assert.equal(au2.agent.ok, true);
  assert.equal(au2.priceBNB, 0.0014);
  assert.ok(au2.maxQty >= 2);
  const ap2 = await post('/api/preview', { address: AURYN, qty: 2 });
  assert.equal(ap2.ok, true, JSON.stringify(ap2));
  assert.deepEqual(ap2.cost, { amount: '0.0028', symbol: 'BNB' });
  assert.equal(ap2.fn, 'mint(uint256,uint256)');

  // Mint nâng cao: tự nhập hàm, tham số, số BNB. Đầu vào lạ bị chặn.
  assert.match((await post('/api/preview', { address: NFT, qty: 1, adv: { fn: 'mint(uint256);drop' } })).error, /Tên hàm/);
  assert.match((await post('/api/preview', { address: NFT, qty: 1, adv: { fn: 'mint(uint256)', args: ['1; rm'] } })).error, /Tham số/);
  assert.match((await post('/api/preview', { address: NFT, qty: 1, adv: { fn: 'mint(uint256)', args: ['1'], valueBnb: 'abc' } })).error, /BNB/);
  const adv = await post('/api/preview', { address: NFT, qty: 1, adv: { fn: 'mint(uint256)', args: ['1'], valueBnb: '0.005' } });
  assert.equal(adv.ok, true, JSON.stringify(adv));
  assert.equal(adv.fn, 'mint(uint256)');
  assert.deepEqual(adv.cost, { amount: '0.005', symbol: 'BNB' });

  // Kiểu Gearz: hàm mint lạ + Agent ID + giá không có hàm đọc. Bot chép cách mint từ giao dịch thành công của người khác,
  // thay ví và Agent ID của họ bằng của bạn, số lượng theo bạn chọn.
  const gz = await post('/api/preview', { address: GEARZ, qty: 3, acceptRisk: true });
  assert.equal(gz.ok, true, JSON.stringify(gz));
  assert.match(gz.fn, /chép từ giao dịch mẫu/);
  assert.equal(gz.qty, '3');
  assert.deepEqual(gz.cost, { amount: '0.0096', symbol: 'BNB' });
  assert.ok(gz.notes.some((x) => /giao dịch thành công của người khác/.test(x) && /Agent ID của bạn/.test(x)), JSON.stringify(gz.notes));

});
