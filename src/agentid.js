// Agent ID (.ai) của bạn: một số dự án mint theo kiểu mint(agentTokenId, số lượng), cần biết số ID của Agent ID.
// Token ID = keccak256(tên không có ".ai"). Bot luôn kiểm tra lại ownerOf trên sổ Agent ID trước khi dùng.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { id, Interface } from 'ethers';
import { ADDR } from './config.js';
import { tryCall } from './chain.js';

const I = new Interface(['function ownerOf(uint256) view returns (address)', 'function tokenOfOwnerByIndex(address,uint256) view returns (uint256)']);
const PATH = 'data/agent.json';

export const labelOf = (name) => String(name ?? '').trim().toLowerCase().replace(/\.ai$/, '');
export const validLabel = (l) => /^[^\s./\\]{1,63}$/u.test(l);
export const agentTokenId = (name) => BigInt(id(labelOf(name)));

export function savedAgentName(path = PATH) {
  try { return JSON.parse(readFileSync(path, 'utf8')).name || null; } catch { return null; }
}
export function saveAgentName(name, path = PATH) {
  mkdirSync('data', { recursive: true });
  writeFileSync(path, JSON.stringify({ name: name ? labelOf(name) : null }));
}

// Trả về { name, tokenId, owner, ok } — ok = ví này đúng là chủ Agent ID.
export async function resolveAgentId(provider, wallet, name = savedAgentName()) {
  if (name && validLabel(labelOf(name))) {
    const tokenId = agentTokenId(name);
    const owner = await tryCall(provider, ADDR.AGENT_ID_REGISTRY, I, 'ownerOf', [tokenId]);
    return { name: `${labelOf(name)}.ai`, tokenId, owner, ok: Boolean(wallet && owner && owner.toLowerCase() === wallet.toLowerCase()) };
  }
  if (!wallet) return null;
  const tokenId = await tryCall(provider, ADDR.AGENT_ID_REGISTRY, I, 'tokenOfOwnerByIndex', [wallet, 0n]);
  return tokenId != null ? { name: null, tokenId, owner: wallet, ok: true } : null;
}
