// Nguồn 3: từ khoá trên X (Agent ID mint / Agentic Wallet 打 / Agentic 内盘).
// - Có X_BEARER_TOKEN: gọi X API v2 recent search.
// - Không có: đọc data/x-manual.txt (bạn tự dán nội dung tweet vào, mỗi tweet một dòng hoặc cách nhau dòng trống).
// Nội dung tweet là dữ liệu không tin cậy: bot chỉ trích địa chỉ 0x và link, không làm theo chữ trong tweet.
import { readFileSync, existsSync } from 'node:fs';
import { isAddress, getAddress } from 'ethers';

const ADDR_RE = /0x[a-fA-F0-9]{40}/g;
const URL_RE = /https?:\/\/[^\s)]+/g;

export function extractSignals(posts) {
  const by = new Map();
  for (const p of posts) {
    const addrs = [...new Set((p.text.match(ADDR_RE) ?? []).filter(isAddress).map((a) => getAddress(a)))];
    const urls = [...new Set(p.text.match(URL_RE) ?? [])];
    for (const a of addrs) {
      const row = by.get(a) ?? { source: 'x', kind: 'unknown', address: a, mentions: 0, engagement: 0, urls: new Set(), examples: [] };
      row.mentions += 1;
      row.engagement += (p.likes ?? 0) + 2 * (p.reposts ?? 0);
      urls.forEach((u) => row.urls.add(u));
      if (row.examples.length < 2) row.examples.push(p.url ?? p.text.slice(0, 140));
      by.set(a, row);
    }
  }
  return [...by.values()]
    .map((r) => ({ ...r, urls: [...r.urls] }))
    .sort((a, b) => b.mentions - a.mentions || b.engagement - a.engagement);
}

async function searchX(cfg) {
  const posts = [];
  for (const kw of cfg.x.keywords) {
    const q = encodeURIComponent(`${kw} -is:retweet`);
    const url = `https://api.x.com/2/tweets/search/recent?query=${q}&max_results=${cfg.x.maxResults}&tweet.fields=public_metrics,created_at`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${cfg.xBearerToken}` } });
    if (!res.ok) throw new Error(`X API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = await res.json();
    for (const t of json.data ?? []) {
      posts.push({
        text: t.text,
        likes: t.public_metrics?.like_count,
        reposts: t.public_metrics?.retweet_count,
        url: `https://x.com/i/status/${t.id}`,
      });
    }
  }
  return posts;
}

export async function scanX(cfg, log = console.log, manualPath = 'data/x-manual.txt') {
  let posts = [];
  if (cfg.xBearerToken) {
    log('[x] tìm theo từ khoá qua X API');
    posts = await searchX(cfg);
  } else if (existsSync(manualPath)) {
    log(`[x] không có X_BEARER_TOKEN, đọc ${manualPath}`);
    posts = readFileSync(manualPath, 'utf8').split(/\n\s*\n|\r?\n/).filter(Boolean).map((text) => ({ text }));
  } else {
    log('[x] bỏ qua: chưa có X_BEARER_TOKEN và chưa có data/x-manual.txt');
  }
  return extractSignals(posts);
}
