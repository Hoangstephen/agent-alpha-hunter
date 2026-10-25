// Lệnh rao bán bot đã đặt trên chợ của web dự án (data/listed.json) + giá gợi ý khi đặt giá bán.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { formatEther } from 'ethers';
import { Ledger } from './ledger.js';

const LISTED = 'data/listed.json';
const readJson = (p, d) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return d; } };

export const listedMap = (path = LISTED) => readJson(path, {});
export function markListed(key, row, path = LISTED) {
  const m = listedMap(path);
  m[key] = { ...row, at: new Date().toISOString() };
  mkdirSync('data', { recursive: true });
  writeFileSync(path, JSON.stringify(m, null, 2));
}

// Giá mint 1 NFT của hợp đồng này (từ sổ mint của bot), tính bằng BNB.
export function mintCostBNB(contract, rows = new Ledger().rows) {
  const r = [...rows].reverse().find((x) => x.target?.toLowerCase() === contract.toLowerCase() && Number(x.qty) > 0);
  return r ? Number(formatEther(BigInt(r.valueWei))) / Number(r.qty) : null;
}

// Giá gợi ý = cao nhất trong: giá bán trung vị gần đây, giá rao rẻ nhất của người khác trên chợ của web,
// giá mint x (1 + % lời), giá tối thiểu. Không có dữ liệu giá nào thì không gợi ý (không bao giờ đoán giá).
export const SUGGEST = { markupPct: 30, minPriceBNB: 0 };
const up4 = (x) => Math.ceil(x * 10_000) / 10_000;
export function suggestPrice({ medianBNB, costBNB, floorBNB }, a = SUGGEST) {
  const c = [];
  if (medianBNB > 0) c.push(medianBNB);
  if (floorBNB > 0) c.push(floorBNB);
  if (costBNB > 0) c.push(costBNB * (1 + a.markupPct / 100));
  if (!c.length) return null;
  if (a.minPriceBNB > 0) c.push(a.minPriceBNB);
  return up4(Math.max(...c));
}
