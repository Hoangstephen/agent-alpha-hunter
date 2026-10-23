// Sổ chi tiêu cục bộ để giữ trần chi tiêu theo ngày.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class Ledger {
  constructor(path = 'data/spend.json') {
    this.path = path;
    this.rows = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : [];
  }

  spentTodayWei(now = new Date()) {
    const day = now.toISOString().slice(0, 10);
    return this.rows.filter((r) => r.at.startsWith(day)).reduce((s, r) => s + BigInt(r.valueWei), 0n);
  }

  add(entry, now = new Date()) {
    this.rows.push({ ...entry, valueWei: entry.valueWei.toString(), at: now.toISOString() });
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.rows, null, 2));
  }
}
