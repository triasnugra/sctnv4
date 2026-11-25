// Pemuat data mesin scalping (sctn / sctnv2 / sctnv3 / ...). Sumber per mesin, urutan coba:
//   LOCAL_DIR (uji)  ->  raw.githubusercontent.com (repo privat: secret MONITOR_TOKEN)  ->  GitHub Pages mesin (publik)
// Berkas: output/signal_log.csv, output/forward_test.json, output/backtest/{summary.json,trades.csv}, output/universe.json
import fs from 'node:fs';
import { parseCSV, toMs, num } from './lib.mjs';

const FILES = {
  signals: 'output/signal_log.csv', forward: 'output/forward_test.json',
  btSummary: 'output/backtest/summary.json', btTrades: 'output/backtest/trades.csv', universe: 'output/universe.json',
};
const PAGES_PATH = { signals: 'data/signal_log.csv', forward: 'data/forward_test.json', btSummary: 'data/backtest/summary.json', btTrades: 'data/backtest/trades.csv', universe: 'data/universe.json' };

async function fetchText(url, headers = {}) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
  if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
  return r.text();
}

// Mengembalikan {teks|null, sumber, galat}
async function getFile(C, e, key, env) {
  const rel = FILES[key];
  if (env.LOCAL_DIR) {
    const p = `${env.LOCAL_DIR}/${e.repo}/${e.repo}-main/${rel}`;
    return fs.existsSync(p) ? { teks: fs.readFileSync(p, 'utf8'), sumber: 'lokal' } : { teks: null, galat: 'tidak ada (lokal)' };
  }
  const tok = env.MONITOR_TOKEN;
  const errs = [];
  try {
    const t = await fetchText(`https://raw.githubusercontent.com/${C.owner}/${e.repo}/${e.branch || 'main'}/${rel}`, tok ? { Authorization: 'token ' + tok } : {});
    return { teks: t, sumber: 'raw' };
  } catch (x) { errs.push('raw ' + x.message); }
  try {
    const t = await fetchText(`https://${C.owner}.github.io/${e.repo}/${PAGES_PATH[key]}?cb=${Date.now()}`);
    return { teks: t, sumber: 'pages' };
  } catch (x) { errs.push('pages ' + x.message); }
  return { teks: null, galat: errs.join('; ') };
}

const OPT = new Set(['btSummary', 'btTrades', 'universe']);

export async function loadEngine(C, e, env = process.env) {
  if (e.fmt === 'history') return loadHistoryEngine(C, e, env);
  const out = { id: e.id, galat: [], sumber: {} };
  for (const k of Object.keys(FILES)) {
    const r = await getFile(C, e, k, env);
    out.sumber[k] = r.sumber ?? null;
    if (r.teks == null) { if (!OPT.has(k)) out.galat.push(`${k}: ${r.galat}`); out[k] = null; continue; }
    try { out[k] = k === 'signals' || k === 'btTrades' ? parseCSV(r.teks) : JSON.parse(r.teks); }
    catch (x) { out.galat.push(`${k}: format tidak terbaca (${x.message})`); out[k] = null; }
  }
  return out;
}

// Waktu commit terakhir sebuah berkas (untuk membedakan "tidak ada sinyal" dari "workflow mati")
export async function lastCommitMs(C, e, path, env = process.env) {
  if (env.LOCAL_DIR) return null;
  try {
    const tok = env.MONITOR_TOKEN;
    const r = await fetch(`https://api.github.com/repos/${C.owner}/${e.repo}/commits?path=${encodeURIComponent(path)}&per_page=1`, {
      headers: { Accept: 'application/vnd.github+json', ...(tok ? { Authorization: 'token ' + tok } : {}) }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    const j = await r.json();
    return j[0] ? Date.parse(j[0].commit.committer.date) : null;
  } catch { return null; }
}

// ---------- Normalisasi ke bentuk trade seragam ----------
// Trade: {id,src,sym,dir,trig,tf,score,sig('ENTRY ZONE'|'PENDING LIMIT'),asof,fill,exit,entry,stop,tp1,tp2,
//         stopPct,status,outcome,rEng,reason,hash}
const T = (o) => o;
export function normForward(raw, C) {
  const logRows = (raw.signals || []).filter(r => String(r.demo ?? '0') !== '1');
  const byId = new Map(logRows.map(r => [r.signal_id, r]));
  const trades = [];
  for (const t of raw.forward?.trades || []) {
    const l = byId.get(t.signal_id) || {};
    const entry = num(t.entry), stop = num(t.stop);
    trades.push(T({
      id: t.signal_id, src: 'fwd', sym: t.symbol, dir: t.direction, trig: t.trigger, tf: t.tf, score: num(t.score),
      sig: l.status || null, asof: toMs(t.asof), fill: toMs(t.fill_time), exit: toMs(t.exit_time),
      entry, stop, tp1: num(t.tp1), tp2: num(t.tp2),
      stopPct: num(l.stop_pct) ?? (entry && stop ? Math.abs(entry - stop) / entry * 100 : null),
      be: num(l.be_stop), f: num(l.tp1_close_pct) ?? 60, bias: l.bias || null,
      status: t.status, outcome: t.outcome || '', rEng: num(t.r), reason: t.reason || '', hash: l.config_hash || null,
    }));
  }
  const ids = new Set(trades.map(t => t.id));
  const tanpaEval = logRows.filter(r => !ids.has(r.signal_id)).map(r => ({ id: r.signal_id, sym: r.symbol, asof: toMs(r.asof_utc), status: r.status }));
  return { trades, logRows, tanpaEval };
}

export function normBacktest(raw) {
  const trades = (raw.btTrades || []).map(t => {
    const entry = num(t.entry), stop = num(t.stop);
    return T({
      id: t.signal_id, src: 'bt', sym: t.symbol, dir: t.direction, trig: t.trigger, tf: t.tf, score: num(t.score),
      sig: t.status_at_signal || null, asof: toMs(t.asof), fill: toMs(t.fill_time), exit: toMs(t.exit_time),
      entry, stop, tp1: num(t.tp1), tp2: num(t.tp2), stopPct: entry && stop ? Math.abs(entry - stop) / entry * 100 : null,
      status: t.status, outcome: t.outcome || '', rEng: num(t.r), reason: t.reason || '', hash: raw.btSummary?.config_hash || null,
    });
  });
  return trades;
}

// R versi monitor: R bersih mesin dibalik ke R kotor (tambah biaya asumsi mesin), lalu dikurangi biaya asumsi monitor.
export function applyCost(trades, engineFeePct, monitorFeePct) {
  for (const t of trades) {
    if (t.rEng == null || !t.stopPct) { t.r = null; t.rGross = null; continue; }
    t.rGross = t.rEng + engineFeePct / t.stopPct;
    t.r = t.rGross - monitorFeePct / t.stopPct;
  }
  return trades;
}

// =====================================================================================================
// ADAPTER mesin berformat "history" (sctnv4: mesin Python yang hanya menerbitkan history.json + data.json ke
// GitHub Pages; tidak ada signal_log.csv / forward_test.json / backtest). Sumber, urutan coba:
//   LOCAL_DIR (uji): <LOCAL_DIR>/<repo>/<repo>-main/{site/,}history.json
//   -> GitHub Pages mesin: https://<owner>.github.io/<repo>/{history,data}.json  (+ raw config.yaml untuk hash)
// =====================================================================================================
async function getHist(C, e, name, env) {
  if (env.LOCAL_DIR) {
    for (const rel of [`site/${name}`, name]) {
      const p = `${env.LOCAL_DIR}/${e.repo}/${e.repo}-main/${rel}`;
      if (fs.existsSync(p)) return { teks: fs.readFileSync(p, 'utf8'), sumber: 'lokal' };
    }
    return { teks: null, galat: 'tidak ada (lokal)' };
  }
  try { return { teks: await fetchText(`https://${C.owner}.github.io/${e.repo}/${name}?cb=${Date.now()}`), sumber: 'pages' }; }
  catch (x) { return { teks: null, galat: 'pages ' + x.message }; }
}

export async function loadHistoryEngine(C, e, env = process.env) {
  const out = { id: e.id, fmt: 'history', galat: [], sumber: {}, hist: null, data: null, cfgText: null, forward: null };
  const h = await getHist(C, e, 'history.json', env);
  out.sumber.history = h.sumber ?? null;
  if (h.teks == null) out.galat.push(`history.json: ${h.galat}`);
  else try { out.hist = JSON.parse(h.teks).signals ?? []; } catch (x) { out.galat.push(`history.json: format tidak terbaca (${x.message})`); }
  const d = await getHist(C, e, 'data.json', env);
  out.sumber.data = d.sumber ?? null;
  if (d.teks != null) try { out.data = JSON.parse(d.teks); } catch { /* opsional */ }
  out.forward = out.data?.generated_at ? { updated: out.data.generated_at } : null;
  // config.yaml hanya ada di repo (bukan di Pages) -> raw; dipakai untuk hash konfigurasi (opsional)
  if (env.LOCAL_DIR) { const p = `${env.LOCAL_DIR}/${e.repo}/${e.repo}-main/config.yaml`; if (fs.existsSync(p)) out.cfgText = fs.readFileSync(p, 'utf8'); }
  else {
    try { out.cfgText = await fetchText(`https://raw.githubusercontent.com/${C.owner}/${e.repo}/${e.branch || 'main'}/config.yaml`, env.MONITOR_TOKEN ? { Authorization: 'token ' + env.MONITOR_TOKEN } : {}); } catch { /* opsional */ }
  }
  return out;
}

// Hash konfigurasi (FNV-1a 32 bit, heksadesimal) atas config.yaml yang dinormalkan (tanpa spasi akhir baris & CRLF)
export function cfgHash(text) {
  if (text == null) return null;
  let h = 0x811c9dc5;
  for (const ch of String(text).replace(/\r/g, '').split('\n').map(x => x.replace(/\s+$/, '')).join('\n').trim()) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

// history.json mesin dipangkas ke N sinyal terakhir (history.max_signals) dan bisa ter-reset bila unduhan
// Pages gagal saat deploy mesin. Arsip monitor menyimpan semua sinyal yang pernah terlihat.
// Sinyal yang sudah selesai tidak diubah lagi; sinyal berjalan diambil dari versi terbaru.
export function mergeArchive(prev = [], fresh = []) {
  const m = new Map();
  for (const s of prev) if (s?.id) m.set(s.id, s);
  for (const s of fresh) {
    if (!s?.id) continue;
    const old = m.get(s.id);
    if (old?.closed_at && old.status !== 'OPEN' && old.status !== 'TP1_OPEN') continue;
    m.set(s.id, s);
  }
  return [...m.values()].sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
}

const OUTCOME = { SL: 'LOSS', TP1_BE: 'TP1_BE', TP1_SL: 'TP1_SL', TP2: 'TP2', TIME: 'TIMEOUT', TP1_TIME: 'TIMEOUT' };
// Bentuk trade seragam dari history.json sctnv4.
//  - r mesin = R bersih (biaya fee+slippage mesin, 0,16% pulang-pergi) -> applyCost() membalik ke kotor lalu memakai biaya monitor.
//  - mesin TIDAK menandai sinyal limit vs entry-zone di history.json dan simulatornya tidak memeriksa pengisian:
//    entry dianggap terisi pada saat sinyal. Karena itu fill = asof (diasumsikan); uji silang 1 menit mengukur selisihnya.
export function normHistory(raw, e) {
  const quote = e.quote || 'USDT', trades = [];
  for (const s of raw.hist || []) {
    const entry = num(s.entry), stop = num(s.stop), asof = toMs(s.time);
    if (!s.id || asof == null || !entry || !stop) continue;
    const closed = !!s.closed_at && s.status !== 'INVALID', invalid = s.status === 'INVALID';
    const dir = String(s.direction || '').toUpperCase();
    trades.push(T({
      id: s.id, src: 'fwd', sym: String(s.symbol).includes('/') ? s.symbol : `${s.symbol}/${quote}`, dir: dir === 'SHORT' ? 'SHORT' : 'LONG',
      trig: s.trigger || '?', tf: '15m', score: num(s.score), sig: 'ENTRY (anggap terisi)', asof, fill: invalid ? null : asof, exit: closed ? toMs(s.closed_at) : null,
      entry, stop, tp1: num(s.tp1), tp2: num(s.tp2), stopPct: Math.abs(entry - stop) / entry * 100,
      be: entry, f: e.tp1FractionPct ?? 60, bias: null, lvl: s.level_label || '',
      status: invalid ? 'CANCELLED' : closed ? 'CLOSED' : 'OPEN', outcome: closed ? (OUTCOME[s.status] || s.status) : '',
      rEng: closed ? num(s.r) : null, reason: invalid ? 'INVALID: jarak stop 0' : '', hash: null, fmt: 'history',
    }));
  }
  return { trades, logRows: [], tanpaEval: [] };
}
