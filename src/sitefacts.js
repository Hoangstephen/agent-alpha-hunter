// Số liệu đọc được từ trang web dự án (dùng khi hợp đồng không có hàm đọc). Lưu trong bộ nhớ, theo địa chỉ hợp đồng.
const perWallet = new Map();

// Hàm thuần: tìm "mỗi ví tối đa N" trong chữ của trang. Trả về số hoặc null.
export function parsePerWallet(text = '') {
  const t = String(text).replace(/\s+/g, ' ');
  const pats = [
    /(?:each|every|per|one) (?:wallet|address)(?: can| may)?(?: mint| hold| claim)?(?: up to| a max(?:imum)? of| max(?:imum)?| at most)? (\d{1,3})\b/i,
    /(?:up to|max(?:imum)?(?: of)?|at most|limit(?:ed)?(?: of| to)?) (\d{1,3})(?: [a-z]+){0,3} (?:per|each|\/|a) ?(?:wallet|address)/i,
    /(\d{1,3})(?: [a-z]+){0,2} (?:per|\/) ?(?:wallet|address)/i,
    /mỗi ví(?: được| chỉ được| có thể)?(?: mint)?(?: tối đa)? (\d{1,3})/i,
  ];
  for (const p of pats) {
    const m = t.match(p);
    const n = m && Number(m[1]);
    if (n >= 1 && n <= 500) return n;
  }
  return null;
}
export const sitePerWallet = (address) => perWallet.get(address.toLowerCase()) ?? null;
export function rememberSite(address, text) {
  const n = parsePerWallet(text);
  if (n) perWallet.set(address.toLowerCase(), n);
  return n;
}
