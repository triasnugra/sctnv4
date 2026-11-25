// Uji ujung-ke-ujung TANPA internet: Binance dipalsukan (candle acak deterministik) agar lapisan live ikut teruji.
// Pemakaian: node test/offline.mjs <folder berisi sctn/ sctnv2/ sctnv3/ hasil unzip>   (lihat README)
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const src = process.argv[2], tmp = process.argv[3] || fs.mkdtempSync('/tmp/monsctn-');
fs.cpSync(src, tmp, { recursive: true });
// Tambah satu sinyal MENUNGGU dan satu BERJALAN pada sctnv2 agar bagian "sinyal menunggu" teruji
const p = `${tmp}/sctnv2/sctnv2-main/output/forward_test.json`, d = JSON.parse(fs.readFileSync(p, 'utf8'));
const asof = new Date(Date.now() - 2 * 36e5).toISOString().replace(/\.\d+Z/, '+00:00');
d.trades.push({ signal_id: 'tes0001', asof, symbol: 'BTC/USDT', direction: 'SHORT', trigger: 'deviation_reclaim', tf: '1h', entry: 1e9, stop: 1.01e9, tp1: 0.9e9, tp2: 0.8e9, score: 7, status: 'WAITING', outcome: '', r: null, fill_time: null, exit_time: null, reason: '' });
fs.writeFileSync(p, JSON.stringify(d));
fs.writeFileSync(`${tmp}/run.mjs`, `
const base = 'https://data-api.binance.vision/api/v3/';
const hash = s => [...s].reduce((a, c) => (Math.imul(a, 31) + c.charCodeAt(0)) | 0, 7);
const STEP = { '1m': 6e4, '15m': 9e5, '1h': 36e5, '1d': 864e5 };
globalThis.fetch = async (url) => {
  const u = new URL(url);
  if (!u.href.startsWith(base)) return new Response('no', { status: 404 });
  if (u.pathname.endsWith('/ticker/price')) {
    const syms = JSON.parse(u.searchParams.get('symbols'));
    return Response.json(syms.map(s => ({ symbol: s, price: String(s === 'BTCUSDT' ? 95000 : 100) })));
  }
  const sym = u.searchParams.get('symbol'), iv = u.searchParams.get('interval'), st = STEP[iv], lim = +u.searchParams.get('limit') || 500;
  if (/^(SOXLB|NVDAB)/.test(sym)) { /* simulasikan candle bolong */ }
  const end = Math.min(+u.searchParams.get('endTime') || Date.now(), Date.now());
  let from = u.searchParams.get('startTime') ? Math.ceil(+u.searchParams.get('startTime') / st) * st : Math.floor(end / st) * st - lim * st;
  const out = []; const base0 = 50 + Math.abs(hash(sym)) % 500;
  for (let t = from; t <= end && out.length < lim; t += st) {
    const i = Math.floor(t / st), w = Math.sin(i / 37) * 0.02 + Math.sin(i / 7) * 0.004, o = base0 * (1 + w), c = base0 * (1 + w + Math.sin(i * 1.7) * 0.001);
    if (/^SOXLB/.test(sym) && i % 11 === 0 && iv === '1h') continue;
    const hi = Math.max(o, c) * 1.0015, lo = Math.min(o, c) * 0.9985;
    out.push([t, String(o), String(hi), String(lo), String(c), String(1000 + (i % 50) * 10), t + st - 1]);
  }
  return Response.json(out);
};
await import('${process.cwd()}/scripts/build.mjs');
`);
execFileSync('node', [`${tmp}/run.mjs`], { env: { ...process.env, LOCAL_DIR: tmp, FORCE_LIVE: '1' }, stdio: 'inherit', cwd: process.cwd() });
