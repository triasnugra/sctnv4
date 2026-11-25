// Fungsi statistik & utilitas umum monitor scalping. Tanpa dependensi.
export const H = 36e5, DAY = 864e5, MIN = 6e4;
export const sum = a => a.reduce((x, y) => x + y, 0);
export const mean = a => (a.length ? sum(a) / a.length : null);
export const sd = a => {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(sum(a.map(x => (x - m) ** 2)) / (a.length - 1));
};
export function quantile(a, q) {
  const s = a.filter(Number.isFinite).sort((x, y) => x - y);
  if (!s.length) return null;
  const p = (s.length - 1) * q, lo = Math.floor(p), hi = Math.ceil(p);
  return s[lo] + (s[hi] - s[lo]) * (p - lo);
}
export const median = a => quantile(a, 0.5);

// Interval Wilson untuk proporsi (win rate)
export function wilson(k, n, z = 1.96) {
  if (!n) return null;
  const p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n);
  const m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [(c - m) / d, (c + m) / d];
}

// PRNG deterministik (agar CI tidak "berkedip" tiap build)
export function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Bootstrap per klaster (hari): sinyal di hari yang sama saling berkorelasi (BTC memimpin altcoin),
// jadi yang diresampling adalah HARI, bukan trade. Mengembalikan CI95 untuk R/trade.
export function clusterBootstrap(groups, B = 2000, minGroups = 10, seed = 7) {
  const g = groups.filter(x => x.length);
  if (g.length < minGroups) return null;
  const rnd = mulberry32(seed), out = [];
  for (let i = 0; i < B; i++) {
    let s = 0, c = 0;
    for (let j = 0; j < g.length; j++) {
      const x = g[Math.floor(rnd() * g.length)];
      for (const v of x) s += v;
      c += x.length;
    }
    out.push(s / c);
  }
  out.sort((a, b) => a - b);
  return [out[Math.floor(B * 0.025)], out[Math.floor(B * 0.975)]];
}

export const iso = ms => new Date(ms).toISOString();
export const dayOf = ms => iso(ms).slice(0, 10);
export const wibDay = ms => iso(ms + 7 * H).slice(0, 10);
export const toMs = s => {
  if (s == null || s === '') return null;
  let x = String(s).trim().replace(' ', 'T');
  if (!/(Z|[+-]\d\d:?\d\d)$/.test(x)) x += 'Z';
  const t = Date.parse(x);
  return Number.isFinite(t) ? t : null;
};
export const num = x => (x === '' || x == null ? null : Number.isFinite(+x) ? +x : null);
export const f2 = (x, d = 2) => (x == null || !Number.isFinite(x) ? '-' : x.toFixed(d));
export const pct = (x, d = 0) => (x == null ? '-' : (100 * x).toFixed(d) + '%');

// CSV RFC4180 sederhana
export function parseCSV(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c !== '\r') cur += c;
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  if (!rows.length) return [];
  const h = rows[0].map(x => x.trim());
  return rows.slice(1).filter(r => r.length > 1 || (r[0] ?? '') !== '').map(r => Object.fromEntries(h.map((k, i) => [k, r[i] ?? ''])));
}
