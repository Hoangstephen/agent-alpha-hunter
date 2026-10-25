// Luật của các dự án đã biết, dịch sang tiếng Việt từ trang chính thức của dự án.
// Thêm dự án mới: thêm 1 mục theo địa chỉ hợp đồng (chữ thường).
export const KNOWN = {
  '0x2c7fbfad6d4709375883f5b57e3c871c96f0dc00': {
    name: 'AURYN Genesis Relic',
    site: 'https://auryn.trade',
    needsAgentId: true,
    agentMint: true,
    perWallet: 4,
    rules: [
      'Ví mint phải sở hữu NFT Agent ID (.ai); hợp đồng kiểm tra quyền sở hữu trên BNB Chain.',
      'Mint tối đa 4 Relic cho mỗi Agent ID, trả bằng BNB.',
      'Giá đọc từ hàm quote(agentTokenId, số lượng) ngay trước khi mint; gửi BNB không quá 1% trên giá quote.',
      'Tiền chuyển về ví dự án (treasury) 0x140E567b311d3BD150A36D818DCcB442c45B79B0, theo hướng dẫn của dự án.',
      'Mint thành công thì NFT về ví đã mint.',
    ],
  },
  // Onchain Agents (BN World): web dựng bằng JavaScript nên bot không đọc được mục chợ trong HTML; chợ đã kiểm trên chain
  // (list(tokenId, giá, số ngày), sự kiện Listed, chợ chỉ hiện NFT có approve(chợ, số token)).
  '0xc4605c6a7765138784b3ca6f9a88e1c249a0d21f': {
    name: 'Onchain Agents',
    site: 'https://bncworld.fun/',
    needsAgentId: true,
    market: { contract: '0xC6cBc2C06ae66d201A761FAa8Ac48aD92B835704', url: 'https://bncworld.fun/' },
  },
  '0xe397a4776f9e7cdc016c332b15756325e4aac84b': {
    name: 'Xuanwu Sigil (EX-00)',
    site: 'https://mchain.art',
    publicSupply: 3000,
    reserve: 888,
    needsAgentId: true,
    perWallet: 3,
    setBonus: { size: 3, text: 'Mint đủ 3 rồi liên kết ví trong Xuanwu Panel để nhận 300 XWP (1 lần mỗi ví)' },
    rules: [
      'Tổng cung 3.888: 3.000 Sigil công khai (id 1–3000) và 888 Sigil dự trữ của dự án (id 3001–3888) dành cho sự kiện và tài trợ.',
      'Chỉ lúc mint gốc mới kiểm tra danh tính: ví mint phải có Binance Agent ID (.ai). Mua bán, giữ và tặng thì ai cũng được.',
      'Tối đa 3 lần mint gốc mỗi ví. Lần 1 miễn phí; lần 2 và 3 mỗi lần ≈1,2 USDT trả bằng BNB, chuyển thẳng vào ví dự án trong cùng giao dịch. Chuyển NFT đi không làm mới giới hạn.',
      'Mint đủ bộ 3 cái, rồi liên kết ví này trong Xuanwu Panel để nhận 300 XWP một lần. Mỗi ví và mỗi tài khoản Panel chỉ nhận 1 lần.',
      'Hợp đồng tối giản và đã xác minh (theo dự án): không giữ tiền, không xin quyền approve; chủ hợp đồng chỉ có thể bật/tắt mint, chỉnh giá trả phí, đặt metadata URI và mint phần dự trữ.',
      '4 bậc, quay ngẫu nhiên on-chain lúc mint và gắn vĩnh viễn vào NFT: Xuanjia 60%, Lingwen 27%, Zhenxing 10%, Shengshou 3%.',
      'Sigil là huy hiệu sưu tầm của Xuanwu Panel, không hứa hẹn giá trị, lợi nhuận hay giá bán lại.',
    ],
  },
};

