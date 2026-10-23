// Danh sách hợp đồng NFT bot theo dõi cho ví: dự án đã biết + địa chỉ bạn đã kiểm tra + hợp đồng đã mint qua bot.
// Đọc số dư bằng balanceOf (lệnh đọc thường, RPC nào cũng chạy), không phụ thuộc vào log.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { getAddress, isAddress } from 'ethers';
import { KNOWN } from './projects.js';

export function watchList(path = 'data/watch.json') {
  let saved = [];
  try { saved = JSON.parse(readFileSync(path, 'utf8')); } catch {}
  return [...new Set([...Object.keys(KNOWN), ...saved].filter((a) => isAddress(a)).map((a) => getAddress(a)))];
}

export function watchAdd(address, path = 'data/watch.json') {
  if (!isAddress(address)) return;
  let saved = [];
  try { saved = JSON.parse(readFileSync(path, 'utf8')); } catch {}
  const a = getAddress(address);
  if (saved.includes(a)) return;
  saved.push(a);
  try { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(saved.slice(-200), null, 2)); } catch {}
}
