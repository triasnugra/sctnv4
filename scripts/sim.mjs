// Port setia simulate_trade() dari mesin sctn (src/evaluate/simulator.py), dengan resolusi candle yang bisa diganti.
// Dipakai monitor untuk UJI SILANG: menghitung ulang hasil trade dengan candle 1 menit supaya kasus
// "stop dan TP tersentuh di candle 15m yang sama" tidak lagi ambigu. Paritas dengan Python diuji di test/parity.mjs.
// Aturan konservatif (sama dengan mesin):
//  - stop & target di candle yang sama -> STOP duluan (setelah TP1: BE duluan)
//  - candle tempat limit terisi hanya dicek stop-nya
//  - pending batal bila TP1 tercapai sebelum terisi, atau lewat pending_expiry_hours
//  - TP1 menutup tp1_close_pct; sisanya BE+ lalu TP2; timeout -> mark-to-market
import { H } from './lib.mjs';

const r4 = x => Math.round(x * 1e4) / 1e4;

// s: {dir, statusSig, asof(ms), entry, stop, tp1, tp2, be, f(0-100), stopPct}
// candles: [{t(open ms), h, l, c}] terurut naik. ev: {fee, expiryH, holdH}
export function simulate(s, candles, ev, tfMs = 15 * 6e4) {
  const long = s.dir === 'LONG', sg = long ? 1 : -1;
  const { entry, stop, tp1, tp2, be } = s;
  const dist = Math.abs(entry - stop), f = s.f / 100;
  const r1 = Math.abs(tp1 - entry) / dist, r2 = Math.abs(tp2 - entry) / dist, beR = (be - entry) * sg / dist;
  const cost = ev.fee / s.stopPct;
  const start = Math.ceil(s.asof / tfMs) * tfMs, expiry = s.asof + ev.expiryH * H, hold = ev.holdH * H;
  const res = { status: 'WAITING', outcome: '', r: null, fill: null, exit: null, reason: '' };
  let filled = s.statusSig === 'ENTRY ZONE', fill = filled ? s.asof : null, stage = 1, last = entry;
  const closed = (outcome, r, ts) => Object.assign(res, { status: 'CLOSED', outcome, r: r4(r - cost), exit: ts, fill });
  for (const k of candles) {
    if (k.t < start) continue;
    const { h: hi, l: lo, c: cl } = k, ts = k.t, closeTs = ts + tfMs;
    if (!filled) {
      if (ts >= expiry) return Object.assign(res, { status: 'CANCELLED', reason: 'pending kedaluwarsa' });
      if (long ? hi >= tp1 : lo <= tp1) {
        const touched = long ? lo <= entry : hi >= entry;
        if (!touched) return Object.assign(res, { status: 'CANCELLED', reason: 'TP1 tercapai sebelum entry terisi' });
      }
      if (long ? lo <= entry : hi >= entry) {
        filled = true; fill = ts;
        if (long ? lo <= stop : hi >= stop) return closed('LOSS', -1, ts);
        last = cl;
      }
      continue;
    }
    if (stage === 1) {
      if (long ? lo <= stop : hi >= stop) return closed('LOSS', -1, ts);
      if (long ? hi >= tp1 : lo <= tp1) { stage = 2; last = cl; continue; }
    } else {
      if (long ? lo <= be : hi >= be) return closed('TP1_BE', f * r1 + (1 - f) * beR, ts);
      if (long ? hi >= tp2 : lo <= tp2) return closed('TP2', f * r1 + (1 - f) * r2, ts);
    }
    last = cl;
    if (closeTs - fill >= hold) {
      const mark = (cl - entry) * sg / dist;
      return closed('TIMEOUT', stage === 1 ? mark : f * r1 + (1 - f) * mark, ts);
    }
  }
  if (!filled) return res;
  const mark = (last - entry) * sg / dist;
  return Object.assign(res, { status: 'OPEN', r: r4((stage === 1 ? mark : f * r1 + (1 - f) * mark) - cost), fill, reason: stage === 2 ? 'TP1 tercapai, sisa berjalan' : '' });
}

// =====================================================================================================
// Port setia simulate_trade() mesin sctnv4 (scalp/risk.py) + varian sadar-pengisian, dengan resolusi candle bebas.
// Aturan mesin (dipertahankan apa adanya, termasuk keanehannya):
//  - tidak ada pemeriksaan pengisian: entry dianggap terisi di harga entry pada saat sinyal
//  - hanya candle dengan waktu buka >= waktu sinyal yang dipakai
//  - stop & TP di candle yang sama -> STOP duluan; TP1 & TP2 di candle yang sama -> hanya TP1 dulu
//  - setelah TP1: stop digeser ke entry (BE); candle TP1 langsung `continue` (tidak ada cek time-stop di candle itu)
//  - time stop = holdH jam sejak SINYAL (bukan sejak terisi), keluar di close candle -> mark-to-market
//  - biaya = ev.fee(%) / stopPct(%) R, dikurangkan sekali pada hasil akhir
// s: {dir, asof(ms), entry, stop, tp1, tp2, f(0-100), stopPct}; ev: {fee(%), holdH}
// =====================================================================================================
export function simulatePy(s, candles, ev) {
  const sg = s.dir === 'LONG' ? 1 : -1, risk = Math.abs(s.entry - s.stop);
  if (!(risk > 0)) return { status: 'CANCELLED', outcome: '', r: 0, exit: null, reason: 'INVALID' };
  const frac = s.f / 100, costR = ev.fee / s.stopPct, rr1 = Math.abs(s.tp1 - s.entry) / risk, rr2 = Math.abs(s.tp2 - s.entry) / risk;
  const maxAge = ev.holdH * H;
  let phase = 0, stopCur = s.stop, realized = 0;
  const done = (outcome, r, exit) => ({ status: 'CLOSED', outcome, r: r4(r), exit });
  for (const k of candles) {
    if (k.t < s.asof) continue;
    const hitStop = sg === 1 ? k.l <= stopCur : k.h >= stopCur;
    const hitTp1 = sg === 1 ? k.h >= s.tp1 : k.l <= s.tp1, hitTp2 = sg === 1 ? k.h >= s.tp2 : k.l <= s.tp2;
    if (phase === 0) {
      if (hitStop) return done('LOSS', -1 - costR, k.t);
      if (hitTp1) { phase = 1; realized = frac * rr1; stopCur = s.entry; continue; }
    } else {
      if (hitStop) return done('TP1_BE', realized - costR, k.t);
      if (hitTp2) return done('TP2', realized + (1 - frac) * rr2 - costR, k.t);
    }
    if (k.t - s.asof >= maxAge) {
      const mark = sg * (k.c - s.entry) / risk;
      return done('TIMEOUT', phase === 0 ? mark - costR : realized + (1 - frac) * mark - costR, k.t);
    }
  }
  return { status: 'OPEN', outcome: '', r: r4(realized), exit: null };
}

// Varian sadar-pengisian: apakah entry benar-benar tersentuh?
//  - bila candle yang memuat waktu sinyal menyentuh entry -> 'zone' (harga ada di entry saat sinyal): hasil = simulatePy
//  - bila tidak -> 'limit' (menunggu retest): terisi saat harga menyentuh entry; batal bila TP1 tercapai lebih dulu
//    atau lewat expiryH jam. Candle pengisian hanya dicek stop-nya (konservatif); sisanya disimulasikan dari candle berikutnya.
export function simulatePyFill(s, candles, ev, expiryH = 24, tfMs = 6e4) {
  const sg = s.dir === 'LONG' ? 1 : -1;
  const c0 = candles.find(k => k.t <= s.asof && s.asof < k.t + tfMs);
  const touch = k => (sg === 1 ? k.l <= s.entry : k.h >= s.entry) && (sg === 1 ? k.h >= s.entry : k.l <= s.entry);
  if (!c0 || touch(c0)) return { kind: 'zone', filled: true, ...simulatePy(s, candles, ev) };
  const expiry = s.asof + expiryH * H;
  for (const k of candles) {
    if (k.t < s.asof) continue;
    if (k.t >= expiry) return { kind: 'limit', filled: false, status: 'CANCELLED', outcome: '', r: null, reason: 'pending kedaluwarsa' };
    const tp1Hit = sg === 1 ? k.h >= s.tp1 : k.l <= s.tp1;
    if (!touch(k)) { if (tp1Hit) return { kind: 'limit', filled: false, status: 'CANCELLED', outcome: '', r: null, reason: 'TP1 tercapai sebelum entry terisi' }; continue; }
    const stopHit = sg === 1 ? k.l <= s.stop : k.h >= s.stop;
    if (stopHit) return { kind: 'limit', filled: true, status: 'CLOSED', outcome: 'LOSS', r: r4(-1 - ev.fee / s.stopPct), exit: k.t, fillT: k.t };
    return { kind: 'limit', filled: true, fillT: k.t, ...simulatePy({ ...s, asof: k.t + tfMs }, candles, ev) };
  }
  return { kind: 'limit', filled: false, status: 'WAITING', outcome: '', r: null, reason: '' };
}
