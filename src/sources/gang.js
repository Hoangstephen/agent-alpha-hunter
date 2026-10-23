// Nguồn 2: token mới tạo trên gang.fun (LaunchpadV2, chỉ ví có Agent ID mới mua được trên curve).
// Đây là TOKEN, không phải NFT: bot chỉ báo tín hiệu, việc mua làm bằng `gang` CLI chính chủ.
import { Interface } from 'ethers';
import { getLogsChunked } from '../chain.js';
import { ADDR } from '../config.js';

export const launchpadV2 = new Interface([
  'event Created(address indexed token, address indexed creator, string name, string symbol, string logoURI, bool taxed, address indexed quote, address refPair, uint256 gradAmt)',
]);

export function parseCreated(logs) {
  return logs.map((l) => {
    const ev = launchpadV2.parseLog(l);
    return {
      source: 'gang.fun',
      kind: 'token',
      address: ev.args.token,
      creator: ev.args.creator,
      name: ev.args.name,
      symbol: ev.args.symbol,
      taxed: ev.args.taxed,
      quote: ev.args.quote,
      block: l.blockNumber,
      tx: l.transactionHash,
    };
  });
}

export async function scanGang(provider, cfg, log = console.log) {
  const head = await provider.getBlockNumber();
  const from = Math.max(head - cfg.scan.blocks * 4, ADDR.GANG_LAUNCHPAD_V2_START_BLOCK);
  log(`[gang.fun] quét token mới block ${from} → ${head}`);
  const topic = launchpadV2.getEvent('Created').topicHash;
  const logs = await getLogsChunked(provider, { address: ADDR.GANG_LAUNCHPAD_V2, topics: [topic] }, from, head, cfg.scan.chunkByAddress ?? 2000);
  return parseCreated(logs).reverse();
}
