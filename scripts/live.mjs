// Lapisan LIVE (butuh jaringan ke Binance saat build di GitHub Actions). Semua fungsi gagal-lunak:
// bila Binance tidak terjangkau, hasilnya null + peringatan, bukan build mati. TIDAK mengubah mesin.
import { H, DAY, MIN, sum, mean, median, quantile, dayOf } from './lib.mjs';
import { simulate, simulatePy, simulatePyFill } from './sim.mjs';

const HOSTS = ['https://data-api.binance.vision', 'https://api.binance.com'];
export async function bj(path) {
  let err;
  for (const h of HOSTS) {
    try {
      const r = await fetch(h + '/api/v3/' + path, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (x) { err = x; }
  }
  throw err;
}
const mapK = a => ({ t: a[0], o: +a[1], h: +a[2], l: +a[3], c: +a[4], v: +a[5] });
const pair = s => s.replace('/', '');

// Candle dengan paging (maks 1000 per panggilan)
export async function klines(sym, iv, startMs, endMs, maxCalls = 12) {
  const out = []; let from = startMs;
  const step = { '1m': MIN, '15m': 15 * MIN, '1h': H, '1d': DAY }[iv];
  for (let i = 0; i < maxCalls; i++) {
    const a = await bj(`klines?symbol=${pair(sym)}&interval=${iv}&startTime=${from}&endTime=${endMs}&limit=1000`);
    if (!a.length) break;
    out.push(...a.map(mapK));
    from = a.at(-1)[0] + step;
    if (a.length < 1000 || from > endMs) break;
  }
  return out;
}
export async function lastK(sym, iv, n) { return (await bj(`klines?symbol=${pair(sym)}&interval=${iv}&limit=${n}`)).map(mapK); }

const ema = (a, n) => { const k = 2 / (n + 1); let e = a[0]; return a.map(v => (e = v * k + e * (1 - k))); };

// ---------- Kondisi pasar untuk scalping (BTC) ----------
export async function regimeScalp(C) {
  const k = (await lastK('BTCUSDT', '1h', 400)).slice(0, -1);
  const rng = k.map(q => (q.h - q.l) / q.c * 100), qv = k.map(q => q.v * q.c);
  const roll = (a, w) => a.map((_, i) => (i + 1 >= w ? mean(a.slice(i + 1 - w, i + 1)) : null)).filter(x => x != null);
  const r24 = roll(rng, 24), v24 = roll(qv, 24);
  const nowR = r24.at(-1), nowV = v24.at(-1), baseR = median(r24.slice(0, -24)), baseV = median(v24.slice(0, -24));
  const c = k.map(q => q.c), e20 = ema(c, 20).at(-1), e50 = ema(c, 50).at(-1), px = c.at(-1);
  const volR = nowR / baseR, volV = nowV / baseV, T = C.regime;
  const arah = px > e20 && e20 > e50 ? 'naik' : px < e20 && e20 < e50 ? 'turun' : 'tidak jelas';
  const flags = [];
  if (volR < T.sepiRange) flags.push(`rentang candle 1H menyempit (${volR.toFixed(2)}x median 14 hari)`);
  if (volV < T.sepiVolume) flags.push(`volume BTC rendah (${volV.toFixed(2)}x median 14 hari)`);
  if (volR > T.ekstrem) flags.push(`volatilitas ekstrem (${volR.toFixed(2)}x median)`);
  const status = volR > T.ekstrem ? 'EKSTREM' : volR < T.sepiRange && volV < T.sepiVolume ? 'SEPI' : flags.length ? 'WASPADA' : 'NORMAL';
  const hr = new Date().getUTCHours();
  return { status, flags, rangeX: volR, volumeX: volV, range24: nowR, arah, btc: px, sesi: hr < 7 ? 'Asia' : hr < 13 ? 'Eropa' : hr < 17 ? 'Eropa+AS' : hr < 22 ? 'AS' : 'Malam' };
}

// Rezim harian BTC (untuk membedah trade per rezim): rentang harian (tertil) & arah vs EMA20 harian
export async function dailyRegime() {
  const k = (await lastK('BTCUSDT', '1d', 200)).slice(0, -1);
  const rg = k.map(q => (q.h - q.l) / q.o * 100), s = [...rg].sort((a, b) => a - b);
  const lo = quantile(s, 1 / 3), hi = quantile(s, 2 / 3), e20 = ema(k.map(q => q.c), 20), out = {};
  k.forEach((q, i) => { out[dayOf(q.t)] = { vol: rg[i] < lo ? 'volatilitas rendah' : rg[i] < hi ? 'volatilitas sedang' : 'volatilitas tinggi', arah: q.c >= e20[i] ? 'BTC di atas EMA20 harian' : 'BTC di bawah EMA20 harian', hariBTC: (q.c / q.o - 1) * 100 }; });
  return out;
}

// ---------- Harga live untuk sinyal menunggu / berjalan ----------
export async function prices(syms) {
  const out = {}, list = [...new Set(syms)];
  for (let i = 0; i < list.length; i += 40) {
    const chunk = list.slice(i, i + 40).map(pair);
    try {
      const a = await bj(`ticker/price?symbols=${encodeURIComponent(JSON.stringify(chunk))}`);
      for (const x of a) out[x.symbol] = +x.price;
    } catch { /* koin di luar Binance: dilewati */ }
  }
  return out;
}

// ---------- UJI SILANG: hitung ulang hasil trade forward dengan candle 1 menit ----------
export async function auditEngine(trades, C, eng = {}) {
  const A = C.audit, now = Date.now(), from = now - A.days * DAY;
  const pool = trades.filter(t => t.asof >= from && t.be != null && t.stopPct && ['CLOSED', 'CANCELLED', 'OPEN'].includes(t.status));
  const bySym = {};
  for (const t of pool) (bySym[t.sym] ??= []).push(t);
  const py = eng.fmt === 'history';
  const ev = py ? { fee: eng.engineFeePct ?? C.engineFeePct, expiryH: C.engineEval.expiryH, holdH: eng.holdH ?? 6 } : { fee: C.engineFeePct, expiryH: C.engineEval.expiryH, holdH: C.engineEval.holdH };
  const fill = py ? { n: 0, zone: 0, limit: 0, batal: 0, rEng: 0, rAware: 0, nAware: 0 } : null;
  const rows = []; let gagal = [];
  for (const [sym, ts] of Object.entries(bySym)) {
    let cs;
    try { cs = await klines(sym, '1m', Math.min(...ts.map(t => t.asof)) - MIN, now, A.maxCalls); } catch (x) { gagal.push(sym); continue; }
    for (const t of ts) {
      if (py) {
        const q = { dir: t.dir, asof: t.asof, entry: t.entry, stop: t.stop, tp1: t.tp1, tp2: t.tp2, f: t.f, stopPct: t.stopPct };
        const r = simulatePy(q, cs, ev), fa = simulatePyFill(q, cs, ev, ev.expiryH, MIN);
        const sama = r.status === t.status && r.outcome === (t.outcome || '') && (r.r == null || t.rEng == null || Math.abs(r.r - t.rEng) <= A.tolR);
        rows.push({ id: t.id, sym, dir: t.dir, eng: [t.status, t.outcome, t.rEng], audit: [r.status, r.outcome, r.r], dR: r.r != null && t.rEng != null ? r.r - t.rEng : null, sama });
        if (t.status === 'CLOSED') {
          fill.n++; fill[fa.kind]++; fill.rEng += t.r ?? 0;
          if (fa.filled && fa.status === 'CLOSED') { fill.rAware += fa.r + (eng.engineFeePct ?? C.engineFeePct) / t.stopPct - C.costPct / t.stopPct; fill.nAware++; }
          else if (!fa.filled) fill.batal++;
        }
        continue;
      }
      const r = simulate({ dir: t.dir, statusSig: t.sig, asof: t.asof, entry: t.entry, stop: t.stop, tp1: t.tp1, tp2: t.tp2, be: t.be, f: t.f, stopPct: t.stopPct }, cs, ev, MIN);
      const sama = r.status === t.status && r.outcome === (t.outcome || '') && (r.r == null || t.rEng == null || Math.abs(r.r - t.rEng) <= A.tolR);
      rows.push({ id: t.id, sym, dir: t.dir, eng: [t.status, t.outcome, t.rEng], audit: [r.status, r.outcome, r.r], dR: r.r != null && t.rEng != null ? r.r - t.rEng : null, sama });
    }
  }
  const beda = rows.filter(x => !x.sama), dR = beda.map(x => x.dR).filter(x => x != null);
  return { fill, n: rows.length, sama: rows.length - beda.length, beda: beda.length, dRrata: dR.length ? mean(dR) : null, dRtotal: dR.length ? sum(dR) : null, rinci: beda.slice(0, 15), gagal };
}

// ---------- Universe: koin yang bukan aset kripto "normal" (saham/ETF tokenisasi, mirip-stablecoin, candle bolong) ----------
export async function universeCheck(symbols, C) {
  const bad = [], known = new Set(C.universeSuspect || []);
  for (let i = 0; i < symbols.length; i += 6) {
    await Promise.all(symbols.slice(i, i + 6).map(async s => {
      const base = s.split('/')[0];
      try {
        const k = await lastK(s, '1h', 200), rg = k.map(q => (q.h - q.l) / q.c * 100), gaps = k.slice(1).filter((q, j) => q.t - k[j].t !== H).length;
        const m = mean(rg);
        const why = [];
        if (gaps > 0) why.push(`${gaps} candle 1H bolong (pasar tutup/jeda: ciri saham tokenisasi)`);
        if (m < C.universe.minRangePct) why.push(`rentang 1H rata-rata ${m.toFixed(3)}% (mirip stablecoin; tidak bisa di-scalp)`);
        if (known.has(base)) why.push('termasuk daftar curiga di config.json');
        if (why.length) bad.push({ s, why });
      } catch { if (known.has(base)) bad.push({ s, why: ['termasuk daftar curiga di config.json (data tidak terbaca)'] }); }
    }));
  }
  return bad;
}

// Versi tanpa jaringan: hanya daftar curiga dari config.json
export function universeStatic(symbols, C) {
  const known = new Set(C.universeSuspect || []);
  return symbols.filter(s => known.has(s.split('/')[0])).map(s => ({ s, why: ['termasuk daftar curiga di config.json (belum dicek live)'] }));
}
