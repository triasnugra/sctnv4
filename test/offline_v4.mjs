// Uji ujung-ke-ujung sctnv4 TANPA internet: history.json/data.json palsu + Binance palsu (candle deterministik).
// Mesin lain (sctn/sctnv2/sctnv3) tidak ada di folder uji -> muncul sebagai peringatan "Data tidak terbaca" (wajar).
// Pemakaian (dari root repo):  node test/offline_v4.mjs [folder-sementara]
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const tmp = process.argv[2] || fs.mkdtempSync('/tmp/monv4-');
const d = `${tmp}/sctnv4/sctnv4-main`;
fs.mkdirSync(`${d}/site`, { recursive: true });
const now = Date.now(), syms = ['BTC', 'ETH', 'SOL', 'PEPE'], sigs = [];
for (let i = 0; i < 40; i++) {
  const t = now - (40 - i) * 0.5 * 36e5, sym = syms[i % 4], long = i % 2 === 0, entry = 100, risk = [0.8, 1.2, 2][i % 3];
  const stop = long ? entry * (1 - risk / 100) : entry * (1 + risk / 100), dd = Math.abs(entry - stop), sg = long ? 1 : -1;
  const st = ['SL', 'TP2', 'TP1_BE', 'TIME', 'SL', 'TP2'][i % 6], open = i >= 38;
  sigs.push({ id: `${sym}-${Math.floor(t / 1000)}`, symbol: sym, direction: long ? 'long' : 'short', trigger: ['T1', 'T2', 'T3', 'T4'][i % 4], level_label: 'range_edge', time: new Date(t).toISOString().replace('Z', '+00:00'),
    entry, stop, tp1: entry + sg * dd * 1.2, tp2: entry + sg * dd * 2.4, score: 75 + (i % 20), status: open ? 'OPEN' : st, r: open ? 0 : { SL: -1.16, TP2: 1.5, TP1_BE: 0.5, TIME: 0.1 }[st],
    closed_at: open ? null : new Date(t + 0.3 * 36e5).toISOString().replace('Z', '+00:00') });
}
fs.writeFileSync(`${d}/site/history.json`, JSON.stringify({ signals: sigs }));
fs.writeFileSync(`${d}/site/data.json`, JSON.stringify({ version: '1.0.0', generated_at: new Date(now - 10 * 6e4).toISOString(), mode: 'live', results: [], signals: sigs, errors: {} }));
fs.writeFileSync(`${d}/config.yaml`, 'symbols: [BTC, ETH, SOL, PEPE]\n');
// arsip sebelumnya berisi 1 sinyal lama yang sudah terpangkas dari history mesin -> harus tetap ada
fs.mkdirSync(`${tmp}/arsip`, { recursive: true });
fs.writeFileSync(`${tmp}/arsip/arsip-sctnv4.json`, JSON.stringify({ signals: [{ ...sigs[0], id: 'BTC-LAMA', time: new Date(now - 23 * 36e5).toISOString().replace('Z', '+00:00'), closed_at: new Date(now - 21 * 36e5).toISOString().replace('Z', '+00:00') }] }));
fs.writeFileSync(`${tmp}/run.mjs`, `
const base = 'https://data-api.binance.vision/api/v3/';
const hash = s => [...s].reduce((a, c) => (Math.imul(a, 31) + c.charCodeAt(0)) | 0, 7);
const STEP = { '1m': 6e4, '15m': 9e5, '1h': 36e5, '1d': 864e5 };
globalThis.fetch = async (url) => {
  const u = new URL(url);
  if (!u.href.startsWith(base)) return new Response('no', { status: 404 });
  if (u.pathname.endsWith('/ticker/price')) return Response.json(JSON.parse(u.searchParams.get('symbols')).map(s => ({ symbol: s, price: '100.2' })));
  const sym = u.searchParams.get('symbol'), iv = u.searchParams.get('interval'), st = STEP[iv], lim = +u.searchParams.get('limit') || 500;
  const end = Math.min(+u.searchParams.get('endTime') || Date.now(), Date.now());
  const from = u.searchParams.get('startTime') ? Math.ceil(+u.searchParams.get('startTime') / st) * st : Math.floor(end / st) * st - lim * st;
  const out = [];
  for (let t = from; t <= end && out.length < lim; t += st) { const i = Math.floor(t / st), w = Math.sin(i / 37) * 0.012 + Math.sin(i / 7) * 0.003, o = 100 * (1 + w), c = 100 * (1 + w + Math.sin(i * 1.7) * 0.001); out.push([t, String(o), String(Math.max(o, c) * 1.0012), String(Math.min(o, c) * 0.9988), String(c), '1000', t + st - 1]); }
  return Response.json(out);
};
await import('${process.cwd()}/scripts/build.mjs');
`);
execFileSync('node', [`${tmp}/run.mjs`], { env: { ...process.env, LOCAL_DIR: tmp, FORCE_LIVE: '1', ARSIP_DIR: `${tmp}/arsip` }, stdio: 'inherit', cwd: process.cwd() });
const out = JSON.parse(fs.readFileSync('site/data.json', 'utf8')), e = out.engines.find(x => x.id === 'sctnv4');
console.log('sctnv4: selesai', e.fwd.n, '| R/trade', e.fwd.avg?.toFixed(3), '| verdict', e.verdict, '| hash', e.hash, '| audit', JSON.stringify(e.audit && { n: e.audit.n, sama: e.audit.sama, beda: e.audit.beda, fill: e.audit.fill }));
const arsip = JSON.parse(fs.readFileSync('site/arsip-sctnv4.json', 'utf8')).signals;
if (!arsip.some(x => x.id === 'BTC-LAMA')) { console.error('GAGAL: sinyal terpangkas hilang dari arsip'); process.exit(1); }
console.log('arsip:', arsip.length, 'sinyal (termasuk yang terpangkas dari history mesin)');
