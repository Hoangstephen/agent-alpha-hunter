// Giá BNB tính bằng USDT: ưu tiên Binance API, dự phòng đọc pool WBNB/USDT trên PancakeSwap V2.
import { Interface, formatUnits } from 'ethers';
import { tryCall } from './chain.js';

const FACTORY = '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73'; // PancakeSwap V2 factory
const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
const USDT = '0x55d398326f99059fF775485246999027B3197955'; // BSC-USD, 18 decimals
const iface = new Interface([
  'function getPair(address,address) view returns (address)',
  'function getReserves() view returns (uint112,uint112,uint32)',
  'function token0() view returns (address)',
]);

let cache = { at: 0, price: null, source: null };

export async function fromBinance(fetchFn = fetch) {
  const r = await fetchFn('https://api.binance.com/api/v3/ticker/price?symbol=BNBUSDT', { signal: AbortSignal.timeout(5000) });
  const j = await r.json();
  const p = Number(j.price);
  if (!(p > 0)) throw new Error('Binance không trả giá');
  return p;
}

export async function fromPancake(provider) {
  const pair = await tryCall(provider, FACTORY, iface, 'getPair', [WBNB, USDT]);
  if (!pair) throw new Error('Không tìm thấy pool');
  const data = await provider.call({ to: pair, data: iface.encodeFunctionData('getReserves') });
  const [r0, r1] = iface.decodeFunctionResult('getReserves', data);
  const t0 = await tryCall(provider, pair, iface, 'token0');
  const [bnb, usdt] = t0.toLowerCase() === WBNB.toLowerCase() ? [r0, r1] : [r1, r0];
  return Number(formatUnits(usdt, 18)) / Number(formatUnits(bnb, 18));
}

export async function bnbUsdt(provider, { ttlMs = 60_000, fetchFn } = {}) {
  if (cache.price && Date.now() - cache.at < ttlMs) return cache;
  try {
    if (process.env.BNB_PRICE_SOURCE === 'onchain') throw new Error('skip');
    cache = { at: Date.now(), price: await fromBinance(fetchFn), source: 'Binance' };
  } catch {
    try {
      cache = { at: Date.now(), price: await fromPancake(provider), source: 'PancakeSwap' };
    } catch {
      // giữ giá cũ nếu có
    }
  }
  return cache;
}

export const resetPriceCache = () => { cache = { at: 0, price: null, source: null }; };
