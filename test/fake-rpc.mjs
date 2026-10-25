// Node BSC giả (JSON-RPC) cho test end-to-end: 1 NFT ERC-721 đang được 20 ví mint.
import http from 'node:http';
import { id, zeroPadValue, AbiCoder, toBeHex } from 'ethers';

const coder = AbiCoder.defaultAbiCoder();
const sel = (s) => id(s).slice(0, 10);
export const NFT = '0x3333333333333333333333333333333333333333';
export const NFT_USDT = '0x5555555555555555555555555555555555555555'; // NFT trả bằng USDT
export const AURYN = '0x7777777777777777777777777777777777777777'; // kiểu AURYN: mint(agentTokenId, qty) + quote()
export const AGENT_LABEL = 'tester';
export const SIGIL = '0x6666666666666666666666666666666666666666'; // kiểu Xuanwu Sigil: mint(), lần đầu free, không khai ERC165
// Kiểu Gearz: hàm mint thật có tên lạ mintCog(to, agentId, qty), bot không tự đoán được; người khác đã mint thành công.
export const GEARZ = '0x8888888888888888888888888888888888888888';
const GEARZ_FN = 'mintCog(address,uint256,uint256)';
const OTHER = '0x0000000000000000000000000000000000002abc';
const GEARZ_TX = '0x' + 'c1'.repeat(32);
const GEARZ_PRICE = 32n * 10n ** 14n;
const APPROVE_TX = '0x' + 'ab'.repeat(32); // txHash mà fake-baw trả về khi execute
let approved = false;
const TRANSFER = id('Transfer(address,address,uint256)');
const ZERO = zeroPadValue('0x00', 32);
const HEAD = 130000000;
const FACTORY = '0xca143ce32fe78f1f7019d7d551a6402fc5350c73';
const PAIR = '0x4444444444444444444444444444444444444444';
const USDT = '0x55d398326f99059fF775485246999027B3197955';
const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
const E = 10n ** 18n;
const pad = (h) => zeroPadValue(h, 32);
const H = (n) => pad(toBeHex(n));
// 4 giao dịch bán NFT: 3 trả BNB trực tiếp, 1 trả bằng WBNB (0.05).
export const SALES = [
  { hash: H(0xa1), seller: '0x0000000000000000000000000000000000002001', value: E / 100n },
  { hash: H(0xa2), seller: '0x0000000000000000000000000000000000002002', value: (E / 100n) * 2n },
  { hash: H(0xa3), seller: '0x0000000000000000000000000000000000002003', value: (E / 100n) * 3n },
  { hash: H(0xa4), seller: '0x0000000000000000000000000000000000002004', value: 0n, wbnb: (E / 100n) * 5n },
];
const baseTx = (s) => ({ hash: s.hash, blockHash: H(1), blockNumber: toBeHex(HEAD - 50), transactionIndex: '0x0', from: '0x0000000000000000000000000000000000009999', to: NFT });

const calls = {
  [sel('price()')]: () => coder.encode(['uint256'], [5n * 10n ** 15n]),
  [sel('maxPerWallet()')]: () => coder.encode(['uint256'], [2n]),
  [sel('totalSupply()')]: () => coder.encode(['uint256'], [120n]),
  [sel('maxSupply()')]: () => coder.encode(['uint256'], [1000n]),
  [sel('name()')]: () => coder.encode(['string'], ['Test <b>Robots</b>']),
  [sel('symbol()')]: () => coder.encode(['string'], ['TR']),
  [sel('paused()')]: () => coder.encode(['bool'], [false]),
  [sel('balanceOf(address)')]: () => coder.encode(['uint256'], [1n]),
  [sel('tokenOfOwnerByIndex(address,uint256)')]: () => coder.encode(['uint256'], [7n]),
  [sel('numberMinted(address)')]: () => coder.encode(['uint256'], [0n]),
  [sel('supportsInterface(bytes4)')]: (d) => coder.encode(['bool'], [d.includes('80ac58cd')]),
};

function handle({ method, params }) {
  switch (method) {
    case 'eth_chainId': return '0x38';
    case 'eth_blockNumber': return toBeHex(HEAD);
    case 'eth_getCode': {
      const a = params[0].toLowerCase();
      if (a === AURYN) return '0x63' + sel('mint(uint256,uint256)').slice(2) + '63' + sel('quote(uint256,uint256)').slice(2) + '63' + sel('ownerOf(uint256)').slice(2) + '73' + '60b9262456de011f7d15a54cdd8c48baaa8b022f' + '00';
      if (a === GEARZ) return '0x63' + sel('mint(address,uint256)').slice(2) + '63' + sel(GEARZ_FN).slice(2) + '00';
      if (a === SIGIL) return '0x63' + sel('mint()').slice(2) + '63' + sel('ownerOf(uint256)').slice(2) + '00';
      return [NFT, NFT_USDT].includes(a) ? '0x63' + sel('mint(uint256)').slice(2) + '00' : '0x';
    }
    case 'eth_getStorageAt': return '0x' + '0'.repeat(64);
    case 'eth_estimateGas': return '0x15f90';
    case 'eth_getTransactionByHash': {
      if (params[0] === GEARZ_TX) return { ...baseTx({ hash: GEARZ_TX }), from: OTHER, to: GEARZ, gas: '0x30000', gasPrice: '0x3b9aca00', nonce: '0x1', value: toBeHex(GEARZ_PRICE * 2n), input: sel(GEARZ_FN) + coder.encode(['address', 'uint256', 'uint256'], [OTHER, BigInt(id('other')), 2n]).slice(2), v: '0x94', r: H(1), s: H(1), type: '0x0', chainId: '0x38' };
      if (BigInt(params[0]) <= 20n) return { ...baseTx({ hash: params[0] }), gas: '0x30000', gasPrice: '0x3b9aca00', nonce: '0x1', value: toBeHex(5n * 10n ** 15n), input: '0x', v: '0x94', r: H(1), s: H(1), type: '0x0', chainId: '0x38' };
      const sl = SALES.find((x) => x.hash === params[0]);
      return sl && { ...baseTx(sl), gas: '0x30000', gasPrice: '0x3b9aca00', nonce: '0x1', value: toBeHex(sl.value), input: '0x', v: '0x94', r: H(1), s: H(1), type: '0x0', chainId: '0x38' };
    }
    case 'eth_getTransactionReceipt': {
      const mintRc = (h) => ({ ...baseTx({ hash: h }), transactionHash: h, contractAddress: null, cumulativeGasUsed: '0x1', gasUsed: '0x15f90', effectiveGasPrice: '0x3b9aca00', logs: [], logsBloom: '0x' + '0'.repeat(512), status: '0x1', type: '0x0' });
      if (BigInt(params[0]) <= 20n) return mintRc(params[0]);
      if (params[0] === APPROVE_TX) { approved = true; return mintRc(params[0]); }
      if (params[0] === '0x' + 'ef'.repeat(32)) return mintRc(params[0]); // giao dịch mint đã gửi
      const sl = SALES.find((x) => x.hash === params[0]);
      const logs = sl?.wbnb ? [{ address: WBNB, topics: [TRANSFER, pad('0x9999'), pad(sl.seller)], data: coder.encode(['uint256'], [sl.wbnb]), blockNumber: toBeHex(HEAD - 50), transactionHash: sl.hash, transactionIndex: '0x0', blockHash: H(1), logIndex: '0x0', removed: false }] : [];
      return sl && { ...baseTx(sl), transactionHash: sl.hash, contractAddress: null, cumulativeGasUsed: '0x1', gasUsed: '0x1', effectiveGasPrice: '0x1', logs, logsBloom: '0x' + '0'.repeat(512), status: '0x1', type: '0x0' };
    }
    case 'eth_getLogs': {
      const f = params[0];
      // NFT ví đã nhận: Sigil #9 (vẫn giữ) và #8 (đã chuyển đi).
      if (!f.address && f.topics?.[0] === TRANSFER && f.topics?.[2]) {
        if (Number(f.toBlock) < HEAD) return [];
        return [8, 9].map((id, i) => ({ address: SIGIL, topics: [TRANSFER, ZERO, f.topics[2], H(id)], data: '0x', blockNumber: toBeHex(HEAD - 5), transactionHash: H(0xb0 + i), transactionIndex: '0x0', blockHash: H(1), logIndex: toBeHex(i), removed: false }));
      }
      if (f.address && f.address.toLowerCase() === GEARZ) {
        if (Number(f.toBlock) < HEAD) return [];
        return [1, 2].map((n) => ({ address: GEARZ, topics: [TRANSFER, ZERO, pad(OTHER), H(n)], data: '0x', blockNumber: toBeHex(HEAD - 10), transactionHash: GEARZ_TX, transactionIndex: '0x0', blockHash: H(1), logIndex: toBeHex(n), removed: false }));
      }
      if (f.address && f.address.toLowerCase() === NFT && f.topics?.[0] === TRANSFER) {
        if (Number(f.toBlock) < HEAD) return [];
        return SALES.map((sl, i) => ({ address: NFT, topics: [TRANSFER, pad(sl.seller), pad('0x9999'), H(500 + i)], data: '0x', blockNumber: toBeHex(HEAD - 50), transactionHash: sl.hash, transactionIndex: '0x0', blockHash: H(1), logIndex: toBeHex(i), removed: false }));
      }
      if (f.topics?.[0] !== TRANSFER || f.address) return [];
      const from = Number(f.fromBlock);
      if (from > HEAD - 100) return []; // chỉ chunk đầu có log
      return Array.from({ length: 20 }, (_, i) => ({
        address: NFT, topics: [TRANSFER, ZERO, zeroPadValue(toBeHex(0x1000 + i), 32), zeroPadValue(toBeHex(i + 1), 32)],
        data: '0x', blockNumber: toBeHex(from + i), transactionHash: zeroPadValue(toBeHex(i + 1), 32), transactionIndex: '0x0',
        blockHash: zeroPadValue('0x01', 32), logIndex: toBeHex(i), removed: false,
      }));
    }
    case 'eth_call': {
      const { to, data } = params[0];
      const t = to.toLowerCase();
      if (t === FACTORY && data.startsWith(sel('getPair(address,address)'))) return coder.encode(['address'], [PAIR]);
      if (t === PAIR && data === sel('getReserves()')) return coder.encode(['uint112', 'uint112', 'uint32'], [6000n * E, 10n * E, 0]); // token0 = USDT
      if (t === PAIR && data === sel('token0()')) return coder.encode(['address'], [USDT]);
      const value = BigInt(params[0].value ?? 0);
      if (t === NFT && data.startsWith(sel('mint(uint256)'))) {
        if (value < BigInt('0x' + data.slice(10)) * 5n * 10n ** 15n) throw Object.assign(new Error('rv'), { rpc: { code: 3, message: 'execution reverted: insufficient value', data: '0x' } });
        return '0x';
      }
      if (t === SIGIL) {
        // Ví giả đã mint 1 lần: lần tiếp theo phải trả 0.0016 BNB.
        if (data === sel('mint()')) {
          if (value < 16n * 10n ** 14n) throw Object.assign(new Error('rv'), { rpc: { code: 3, message: 'execution reverted: wrong value', data: '0x' } });
          return '0x';
        }
        if (data.startsWith(sel('name()'))) return coder.encode(['string'], ['Xuanwu Sigil']);
        if (data.startsWith(sel('paidPrice()'))) return coder.encode(['uint256'], [16n * 10n ** 14n]);
        if (data.startsWith(sel('maxPerWallet()'))) return coder.encode(['uint256'], [3n]);
        if (data.startsWith(sel('numberMinted(address)'))) return coder.encode(['uint256'], [1n]);
        if (data.startsWith(sel('balanceOf(address)'))) return coder.encode(['uint256'], [1n]);
        if (data.startsWith(sel('ownerOf(uint256)'))) return coder.encode(['address'], [BigInt('0x' + data.slice(10)) === 9n ? '0x1111111111111111111111111111111111111111' : '0x0000000000000000000000000000000000002222']);
      }
      if (t === NFT_USDT && data === sel('mint(uint256)').concat(data.slice(10)) && data.startsWith(sel('mint(uint256)'))) {
        if (!approved) throw Object.assign(new Error('rv'), { rpc: { code: 3, message: 'execution reverted: allowance', data: '0x' } });
        return '0x';
      }
      if (t === NFT_USDT) {
        const d = data.slice(0, 10);
        if (d === sel('price()')) return coder.encode(['uint256'], [3n * E]);
        if (d === sel('paymentToken()')) return coder.encode(['address'], [USDT]);
        if (d === sel('maxPerWallet()')) return coder.encode(['uint256'], [4n]);
        if (d === sel('numberMinted(address)')) return coder.encode(['uint256'], [0n]);
        if (d === sel('supportsInterface(bytes4)')) return coder.encode(['bool'], [data.includes('80ac58cd')]);
        if (d === sel('name()')) return coder.encode(['string'], ['USDT Relics']);
      }
      if (t === USDT.toLowerCase()) {
        if (data.startsWith(sel('decimals()'))) return coder.encode(['uint8'], [18]);
        if (data.startsWith(sel('allowance(address,address)'))) return coder.encode(['uint256'], [approved ? 12n * E : 0n]);
      }
      if (t === GEARZ) {
        if (data.startsWith(sel(GEARZ_FN))) {
          const [to, aid, q] = coder.decode(['address', 'uint256', 'uint256'], '0x' + data.slice(10));
          const from = String(params[0].from ?? '').toLowerCase();
          const owner = aid === BigInt(id(AGENT_LABEL)) ? '0x1111111111111111111111111111111111111111' : aid === BigInt(id('other')) ? OTHER : null;
          if (to.toLowerCase() !== from || owner !== from) throw Object.assign(new Error('rv'), { rpc: { code: 3, message: 'execution reverted (unknown custom error)', data: '0x12345678' } });
          if (value < GEARZ_PRICE * q) throw Object.assign(new Error('rv'), { rpc: { code: 3, message: 'execution reverted (unknown custom error)', data: '0x12345678' } });
          return '0x';
        }
        if (data.startsWith(sel('name()'))) return coder.encode(['string'], ['Gearz Cog']);
        throw Object.assign(new Error('rv'), { rpc: { code: 3, message: 'execution reverted (unknown custom error)', data: '0x12345678' } });
      }
      if (t === AURYN) {
        const AID = BigInt(id(AGENT_LABEL));
        if (data.startsWith(sel('quote(uint256,uint256)'))) { const [, q] = coder.decode(['uint256', 'uint256'], '0x' + data.slice(10)); return coder.encode(['uint256'], [14n * 10n ** 14n * q]); }
        if (data.startsWith(sel('mint(uint256,uint256)'))) {
          const [aid, q] = coder.decode(['uint256', 'uint256'], '0x' + data.slice(10));
          if (aid !== AID) throw Object.assign(new Error('rv'), { rpc: { code: 3, message: 'execution reverted: not agent owner', data: '0x' } });
          if (value < 14n * 10n ** 14n * q) throw Object.assign(new Error('rv'), { rpc: { code: 3, message: 'execution reverted: low value', data: '0x' } });
          return '0x';
        }
        if (data.startsWith(sel('name()'))) return coder.encode(['string'], ['AURYN Relic']);
        if (data.startsWith(sel('totalSupply()'))) return coder.encode(['uint256'], [142n]);
        if (data.startsWith(sel('maxSupply()'))) return coder.encode(['uint256'], [1000n]);
        if (data.startsWith(sel('balanceOf(address)'))) return coder.encode(['uint256'], [0n]);
      }
      if (t === '0x60b9262456de011f7d15a54cdd8c48baaa8b022f' && data.startsWith(sel('ownerOf(uint256)'))) {
        if (BigInt('0x' + data.slice(10)) === BigInt(id(AGENT_LABEL))) return coder.encode(['address'], ['0x1111111111111111111111111111111111111111']);
        if (BigInt('0x' + data.slice(10)) === BigInt(id('other'))) return coder.encode(['address'], [OTHER]);
        throw Object.assign(new Error('rv'), { rpc: { code: 3, message: 'execution reverted: nonexistent', data: '0x' } });
      }
      if (t === '0x60b9262456de011f7d15a54cdd8c48baaa8b022f' && data.startsWith(sel('balanceOf(address)'))) return coder.encode(['uint256'], [1n]);
      const fn = t === NFT || t === '0x60b9262456de011f7d15a54cdd8c48baaa8b022f' ? calls[data.slice(0, 10)] : null;
      if (!fn) throw Object.assign(new Error('execution reverted'), { rpc: { code: 3, message: 'execution reverted', data: '0x' } });
      return fn(data);
    }
    default: throw Object.assign(new Error('nope'), { rpc: { code: -32601, message: 'method not found' } });
  }
}

export const stats = { requests: 0 };
export function startFakeRpc(port, { delayMs = 0 } = {}) {
  return new Promise((res) => {
    const s = http.createServer(async (req, resp) => {
      let raw = '';
      for await (const c of req) raw += c;
      stats.requests += 1;
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      const one = (m) => { try { return { jsonrpc: '2.0', id: m.id, result: handle(m) }; } catch (e) { return { jsonrpc: '2.0', id: m.id, error: e.rpc }; } };
      const body = JSON.parse(raw);
      resp.writeHead(200, { 'content-type': 'application/json' });
      resp.end(JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)));
    }).listen(port, '127.0.0.1', () => res(s));
  });
}
