// Học cách mint từ giao dịch mint THÀNH CÔNG của người khác trên cùng hợp đồng.
// Dùng khi cách mint mặc định bị hợp đồng từ chối (hàm lạ, tham số Agent ID, giá không có hàm đọc...).
// Chép đúng dữ liệu gọi hàm của họ, chỉ thay: địa chỉ ví của họ → ví bạn, Agent ID của họ → Agent ID của bạn,
// số lượng → số bạn chọn (khi biết chắc vị trí). Kết quả vẫn phải qua mô phỏng + guardCall + bạn xác nhận.
import { Interface, id, getAddress } from 'ethers';
import { ADDR } from './config.js';
import { TOPIC, getLogsChunked, tryCall, topicToAddress } from './chain.js';
import { resolveAgentId } from './agentid.js';

const REG = new Interface(['function ownerOf(uint256) view returns (address)']);
const pad = (a) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const word = (n) => BigInt(n).toString(16).padStart(64, '0');

// Giao dịch mint gần đây gửi THẲNG vào hợp đồng (không qua router), mới nhất trước.
export async function recentMintTxs(provider, contract, { blocks = 20_000, chunk = 2000, max = 6 } = {}) {
  const head = await provider.getBlockNumber();
  const logs = await getLogsChunked(provider, { address: contract, topics: [TOPIC.TRANSFER, TOPIC.ZERO] }, head - blocks, head, chunk, { concurrency: 4, deadlineMs: 15_000 });
  const byTx = new Map();
  for (const l of logs) {
    if (l.topics.length !== 4) continue;
    const r = byTx.get(l.transactionHash) ?? { hash: l.transactionHash, minter: topicToAddress(l.topics[2]), n: 0, block: l.blockNumber };
    r.n += 1;
    byTx.set(l.transactionHash, r);
  }
  const rows = [...byTx.values()].sort((a, b) => b.block - a.block).slice(0, max * 3);
  const out = [];
  for (const r of rows) {
    if (out.length >= max) break;
    const tx = await provider.getTransaction(r.hash).catch(() => null);
    if (!tx?.to || tx.to.toLowerCase() !== contract.toLowerCase() || !tx.data || tx.data.length < 10) continue;
    out.push({ ...r, from: tx.from, data: tx.data, valueWei: tx.value });
  }
  return out;
}

// Dựng lại lệnh mint cho ví bạn từ 1 giao dịch mẫu. Trả về null nếu không chép được an toàn.
export async function adaptTx(provider, sample, { walletAddr, qty = 1n, candidates = [], myAgentTokenId = null }) {
  const selector = sample.data.slice(0, 10).toLowerCase();
  let body = sample.data.slice(10).toLowerCase();
  if (body.length % 64) return null;
  const notes = [];
  // 1) Địa chỉ ví người mint mẫu → ví bạn.
  for (const a of new Set([sample.from, sample.minter].filter(Boolean).map((x) => x.toLowerCase()))) body = body.split(pad(a)).join(pad(walletAddr));
  // 2) Số rất lớn mà người mint mẫu đang sở hữu trên sổ Agent ID = Agent ID của họ → thay bằng của bạn.
  const words = body.match(/.{64}/g) ?? [];
  for (let i = 0; i < words.length; i++) {
    const v = BigInt('0x' + words[i]);
    if (v < 2n ** 128n) continue;
    const owner = await tryCall(provider, ADDR.AGENT_ID_REGISTRY, REG, 'ownerOf', [v]);
    if (!owner || ![sample.from, sample.minter].some((x) => x && x.toLowerCase() === owner.toLowerCase())) continue;
    if (myAgentTokenId == null) return { needAgentId: true };
    words[i] = word(myAgentTokenId);
    notes.push('dùng Agent ID của bạn');
  }
  // 3) Số lượng: tham số cuối bằng đúng số NFT của giao dịch mẫu → đó là số lượng (kiểu mint phổ biến).
  //    Biết tên hàm thì kiểm tra thêm đúng là uint. Mô phỏng ở bước sau sẽ xác nhận lại.
  let outQty = BigInt(sample.n);
  const sig = candidates.find((s) => id(s).slice(0, 10) === selector);
  const frag = sig ? new Interface([`function ${sig}`]).fragments[0] : null;
  const last = frag ? frag.inputs.length - 1 : words.length - 1;
  const lastIsUint = frag ? last >= 0 && frag.inputs[last].type.startsWith('uint') : last >= 0;
  if (lastIsUint && words[last] && BigInt('0x' + words[last]) === BigInt(sample.n)) {
    words[last] = word(qty);
    outQty = BigInt(qty);
  }
  if (outQty !== BigInt(qty)) notes.push(`hàm này mỗi lần mint ${outQty} NFT`);
  const valueWei = (BigInt(sample.valueWei) * outQty) / BigInt(sample.n || 1);
  return { data: selector + words.join(''), valueWei, qty: outQty, fn: sig ?? `${selector} (chép từ giao dịch mẫu)`, sample: sample.hash, notes };
}

// Thử lần lượt các giao dịch mẫu, cái nào mô phỏng chạy được cho ví bạn thì dùng.
export async function learnMint(provider, contract, { walletAddr, qty = 1n, candidates = [], txs } = {}) {
  txs ??= await recentMintTxs(provider, getAddress(contract)).catch(() => []);
  if (!txs.length) return null;
  const agent = await resolveAgentId(provider, walletAddr).catch(() => null);
  const myAgentTokenId = agent?.ok ? agent.tokenId : null;
  let needAgentId = false;
  for (const s of txs) {
    const a = await adaptTx(provider, s, { walletAddr, qty: BigInt(qty), candidates, myAgentTokenId });
    if (!a) continue;
    if (a.needAgentId) { needAgentId = true; continue; }
    const vals = [...new Set([a.valueWei, 0n])];
    for (const v of vals) {
      try {
        await provider.call({ from: walletAddr, to: contract, data: a.data, value: v });
        return { ...a, valueWei: v };
      } catch {}
    }
  }
  return needAgentId ? { needAgentId: true } : null;
}
