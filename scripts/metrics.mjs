// Metrik khusus evaluasi mesin scalping. Semua input = trade seragam dari load.mjs (R = R versi monitor, sudah bersih biaya).
import { sum, mean, sd, median, quantile, wilson, clusterBootstrap, dayOf, H, DAY } from './lib.mjs';

export const isClosed = t => t.status === 'CLOSED' && t.r != null;

// ---------- Kinerja inti ----------
export function perf(rows) {
  const f = rows.filter(isClosed).sort((a, b) => (a.exit ?? a.asof) - (b.exit ?? b.asof));
  const n = f.length, rs = f.map(t => t.r);
  if (!n) return { n: 0 };
  const wins = rs.filter(r => r > 0), loss = rs.filter(r => r < 0);
  const gp = sum(wins), gl = -sum(loss), m = mean(rs), s = sd(rs);
  // ekuitas berurutan menurut waktu keluar
  let eq = 0, peak = 0, dd = 0, ddNow = 0, streak = 0, maxStreak = 0;
  const curve = [];
  for (const t of f) {
    eq += t.r; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); ddNow = peak - eq;
    streak = t.r < 0 ? streak + 1 : 0; maxStreak = Math.max(maxStreak, streak);
    curve.push([t.exit ?? t.asof, +eq.toFixed(3)]);
  }
  // klaster per hari (UTC) berdasarkan waktu sinyal
  const byDay = {};
  for (const t of f) (byDay[dayOf(t.asof)] ??= []).push(t.r);
  const days = Object.keys(byDay).length;
  const first = Math.min(...f.map(t => t.asof)), last = Math.max(...f.map(t => t.asof));
  const sorted = [...rs].sort((a, b) => b - a), pos = sum(sorted.filter(x => x > 0)), top3 = sum(sorted.slice(0, 3).filter(x => x > 0));
  const hold = f.filter(t => t.fill && t.exit).map(t => (t.exit - t.fill) / H);
  const delay = f.filter(t => t.fill && t.asof).map(t => Math.max(0, (t.fill - t.asof) / H));
  const outcomes = {};
  for (const t of f) outcomes[t.outcome || '?'] = (outcomes[t.outcome || '?'] || 0) + 1;
  const spanDays = Math.max(1, (last - first) / DAY);
  return {
    n, wins: wins.length, losses: loss.length, winRate: wins.length / n, winCI: wilson(wins.length, n),
    avg: m, med: median(rs), total: sum(rs), sd: s, sqn: s > 0 ? Math.sqrt(n) * m / s : null,
    pf: gl > 0 ? gp / gl : null, ci: clusterBootstrap(Object.values(byDay)), ciHari: days,
    avgWin: wins.length ? mean(wins) : null, avgLoss: loss.length ? mean(loss) : null,
    payoff: wins.length && loss.length ? mean(wins) / -mean(loss) : null,
    best: sorted[0], worst: sorted.at(-1), maxDD: dd, ddNow, maxStreak,
    top3Share: pos > 0 ? top3 / pos : null, avgEx3: n > 3 ? mean(sorted.slice(3)) : null,
    outcomes, minggu: (last - first) / (7 * DAY), spanDays, hari: days, perHari: n / spanDays,
    hold: hold.length ? { p25: quantile(hold, .25), med: quantile(hold, .5), p75: quantile(hold, .75), p90: quantile(hold, .9), mean: mean(hold),
      le1: hold.filter(x => x <= 1).length / hold.length, le4: hold.filter(x => x <= 4).length / hold.length,
      le12: hold.filter(x => x <= 12).length / hold.length, gt24: hold.filter(x => x > 24).length / hold.length } : null,
    delay: delay.length ? { med: quantile(delay, .5), p90: quantile(delay, .9) } : null,
    stopMed: median(f.map(t => t.stopPct)), curve,
  };
}

// ---------- Corong sinyal -> terisi -> selesai ----------
export function funnel(rows) {
  const c = { total: rows.length, CLOSED: 0, OPEN: 0, WAITING: 0, CANCELLED: 0 };
  const why = {}, bySig = {};
  for (const t of rows) {
    c[t.status] = (c[t.status] || 0) + 1;
    if (t.status === 'CANCELLED') why[t.reason || '?'] = (why[t.reason || '?'] || 0) + 1;
    const k = t.sig || 'tidak diketahui';
    const g = bySig[k] ??= { n: 0, terisi: 0, batal: 0, menunggu: 0 };
    g.n++;
    if (t.status === 'CLOSED' || t.status === 'OPEN') g.terisi++;
    else if (t.status === 'CANCELLED') g.batal++; else g.menunggu++;
  }
  const decided = c.CLOSED + c.OPEN + c.CANCELLED;
  return { ...c, fillRate: decided ? (c.CLOSED + c.OPEN) / decided : null, why, bySig: Object.entries(bySig).map(([k, g]) => ({ k, ...g, fill: g.terisi + g.batal ? g.terisi / (g.terisi + g.batal) : null })) };
}

// ---------- Pecahan per dimensi ----------
export function breakdown(rows, keyFn, minShow = 1) {
  const g = {};
  for (const t of rows.filter(isClosed)) (g[keyFn(t)] ??= []).push(t);
  return Object.entries(g).filter(([, v]) => v.length >= minShow).map(([k, v]) => {
    const p = perf(v);
    return { k, n: p.n, win: p.winRate, avg: p.avg, total: p.total, pf: p.pf, hold: p.hold?.med ?? null };
  }).sort((a, b) => b.total - a.total);
}
// Sesi dalam UTC (WIB = UTC+7), berdasar waktu sinyal
export const sesi = t => {
  const h = new Date(t.asof).getUTCHours();
  return h < 7 ? 'Asia 00-07 UTC (07-14 WIB)' : h < 13 ? 'Eropa 07-13 UTC (14-20 WIB)' : h < 17 ? 'Eropa+AS 13-17 UTC (20-24 WIB)' : h < 22 ? 'AS 17-22 UTC (00-05 WIB)' : 'Malam 22-24 UTC (05-07 WIB)';
};
// skor mesin sctn* berskala 0-10; sctnv4 berskala 0-100 (ambang TRADE 75) -> dibagi 10 agar seragam
export const skorBucket = t => { if (t.score == null) return '?'; const x = t.score > 10 ? t.score / 10 : t.score; return x >= 9 ? 'skor >= 9' : x >= 7 ? 'skor 7-8' : 'skor <= 6'; };
export const hari = t => ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'][new Date(t.asof).getUTCDay()];
export const stopBucket = t => (t.stopPct == null ? '?' : t.stopPct < 0.85 ? 'stop <0,85% (fee besar)' : t.stopPct < 1.5 ? 'stop 0,85-1,5%' : 'stop >= 1,5%');

// ---------- Level unik: sinyal berulang dengan level sama = SATU trade independen ----------
export function levels(rows) {
  const f = rows.filter(isClosed), g = {};
  for (const t of f) (g[[t.sym, t.dir, t.entry, t.stop, t.tp1].join('|')] ??= []).push(t);
  const L = Object.values(g);
  if (!L.length) return null;
  const lv = L.map(v => mean(v.map(t => t.r)));
  return { n: f.length, u: L.length, dup: f.length - L.length, neff: f.length ** 2 / sum(L.map(v => v.length ** 2)), mean: mean(lv), win: lv.filter(x => x > 0).length / lv.length, big: L.reduce((a, v) => (v.length > a.n ? { n: v.length, s: v[0].sym, d: v[0].dir } : a), { n: 0 }) };
}

// ---------- Konsentrasi & ketahanan ----------
export function leaveOut(rows, k = 2) {
  const f = rows.filter(isClosed), by = {};
  for (const t of f) by[t.sym] = (by[t.sym] || 0) + t.r;
  const top = Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, k).map(x => x[0]);
  const rest = f.filter(t => !top.includes(t.sym)), p = perf(rest);
  return { top, topTotal: sum(top.map(s => by[s])), total: sum(f.map(t => t.r)), restN: rest.length, restAvg: p.avg ?? null, restTotal: p.total ?? 0, restPf: p.pf ?? null };
}

// ---------- Sensitivitas biaya (persen notional pulang-pergi) ----------
export function costCurve(rows, costs = [0, 0.05, 0.1, 0.15, 0.2, 0.3]) {
  const f = rows.filter(t => isClosed(t) && t.rGross != null && t.stopPct);
  if (!f.length) return null;
  const at = c => mean(f.map(t => t.rGross - c / t.stopPct));
  const be = mean(f.map(t => t.rGross)) / mean(f.map(t => 1 / t.stopPct));
  return { be, curve: costs.map(c => ({ c, r: at(c) })), feeR: median(f.map(t => 1 / t.stopPct)) };
}

// ---------- Gerbang kelayakan (HANYA forward test; backtest bukan bukti) ----------
export function gates(p, rows, C) {
  const L = rows.filter(t => isClosed(t) && t.dir === 'LONG').length, S = rows.filter(t => isClosed(t) && t.dir === 'SHORT').length;
  const g = [
    [p.n >= C.minTrades, `Trade selesai ${p.n || 0}/${C.minTrades}`],
    [(p.minggu || 0) >= C.minWeeks, `Minggu data ${(p.minggu || 0).toFixed(1)}/${C.minWeeks}`],
    [!!p.ci && p.ci[0] > 0, 'CI95 bawah R/trade > 0 (bootstrap per hari)'],
    [p.pf != null && p.pf >= C.minPF, `Profit factor >= ${C.minPF} (setelah biaya ${C.costPct}%)`],
    [L >= C.minPerSide && S >= C.minPerSide, `Dua arah teruji: LONG ${L} / SHORT ${S} (min ${C.minPerSide} masing-masing)`],
  ];
  return { list: g, layak: g.every(x => x[0]) };
}

// Fingerprint daftar trade (untuk mendeteksi backtest identik antar mesin)
export const fingerprint = rows => {
  const f = rows.filter(isClosed).map(t => t.id).sort();
  let h = 0;
  for (const s of f.join('|')) h = (Math.imul(h, 31) + s.charCodeAt(0)) | 0;
  return `${f.length}:${(h >>> 0).toString(16)}`;
};
