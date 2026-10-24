import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Địa chỉ đã kiểm chứng (nguồn: github.com/gangfun/gang-launchpad, config/MainnetAddresses.sol)
export const ADDR = {
  AGENT_ID_REGISTRY: '0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F', // SPACE ID Agent ID (.ai), ERC-721 soulbound
  GANG_LAUNCHPAD_V2: '0x1B8F3f69DFa0a7F63d308C7EB0Fd38D8b099966E',
  GANG_LAUNCHPAD_V2_START_BLOCK: 129311617,
};

export const DEFAULTS = {
  rpcUrl: '',               // để trống: bot tự chọn RPC công khai còn chạy
  binanceChainId: '56',
  // Ví Agentic Wallet (địa chỉ công khai). Để trống thì bot hỏi `baw wallet address`.
  walletAddress: '',
  scan: {
    blocks: 1200,            // ~1200 block BSC (0.45 giây/block) ≈ 9 phút gần nhất
    chunk: 50,               // số block mỗi lần eth_getLogs khi quét mọi hợp đồng (RPC công khai giới hạn)
    chunkByAddress: 2000,    // khi lọc theo 1 hợp đồng / 1 ví, log ít nên quét đoạn lớn được (tự chia nhỏ nếu RPC chê)
    minMints: 15,            // tối thiểu số NFT được mint trong cửa sổ quét
    minUniqueMinters: 8,     // tối thiểu số ví mint khác nhau
    sampleMintersForAgentCheck: 15,
    top: 15,
  },
  x: {
    keywords: ['"Agent ID" mint', '"Agentic Wallet" 打', 'Agentic 内盘'],
    maxResults: 50,
  },
  limits: {
    maxPerMintBNB: 0.05,     // trần chi tiêu mỗi lần mint (giá + quy đổi stablecoin, chưa gồm gas)
    maxDailyBNB: 0.2,        // trần chi tiêu mỗi ngày (cộng dồn trong data/spend.json)
    defaultMaxQty: 20,       // số lượng tối đa khi dự án không công bố giới hạn
    minRiskScore: 60,        // dưới mức này bot từ chối mint
  },
};

function merge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b ?? {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge(a[k] ?? {}, v) : v;
  }
  return out;
}

export function loadConfig(path = 'config.json') {
  const p = resolve(path);
  const user = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
  const cfg = merge(DEFAULTS, user);
  // RPC riêng dán trên giao diện được lưu ở data/rpc.json (chứa API key: không chia sẻ file này).
  try { const saved = JSON.parse(readFileSync(resolve('data/rpc.json'), 'utf8')).url; if (saved) cfg.rpcUrl = saved; } catch {}
  if (process.env.BSC_RPC_URL) cfg.rpcUrl = process.env.BSC_RPC_URL;
  // Khoá API chỉ đọc từ biến môi trường, không bao giờ ghi vào file.
  cfg.xBearerToken = process.env.X_BEARER_TOKEN || '';
  cfg.etherscanKey = process.env.ETHERSCAN_API_KEY || '';
  // Element API key dán trên giao diện được lưu ở data/element.json (không chia sẻ file này).
  let el = {};
  try { el = JSON.parse(readFileSync(resolve('data/element.json'), 'utf8')); } catch {}
  cfg.elementKey = process.env.ELEMENT_API_KEY || el.key || '';
  return cfg;
}
