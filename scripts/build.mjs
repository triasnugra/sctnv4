// Monitor mesin SCALPING (sctn / sctnv2 / sctnv3 ...). Membaca keluaran tiap mesin, menghitung ulang kinerja
// dengan metrik khusus scalping, dan membangun site/ (data.json + index.html + laporan.md).
// Mesin TIDAK diubah. Penilaian utama = forward test; backtest hanya hipotesis.
import fs from 'node:fs';
import { loadEngine, lastCommitMs, normForward, normBacktest, normHistory, applyCost, cfgHash, mergeArchive } from './load.mjs';
import { perf, funnel, breakdown, levels, leaveOut, costCurve, gates, fingerprint, isClosed, sesi, skorBucket, hari, stopBucket } from './metrics.mjs';
import * as live from './live.mjs';
import { H, DAY, f2, pct, iso, median, dayOf, wibDay } from './lib.mjs';
import { buildLog, recon } from './laporan-log.mjs';
import { buildReport } from './report.mjs';

const C = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const NOW = process.env.FAKE_NOW ? Date.parse(process.env.FAKE_NOW) : Date.now();
const ONLINE = !process.env.LOCAL_DIR || process.env.FORCE_LIVE === '1';
const out = { updated: iso(NOW), cfg: { costPct: C.costPct, engineFeePct: C.engineFeePct, minTrades: C.minTrades, minWeeks: C.minWeeks, minPF: C.minPF, minPerSide: C.minPerSide, commonStart: C.commonStart }, engines: [], warnings: [], silang: {} };
const W = (lvl, e, t, aksi = null) => out.warnings.push({ lvl, e, t, aksi });
const down = (a, n = 260) => (a.length <= n ? a : a.filter((_, i) => i % Math.ceil(a.length / n) === 0 || i === a.length - 1));
const slim = rows => rows.map(r => ({ ...r, hold: r.hold == null ? null : +r.hold.toFixed(2) }));

// ---------- 1. Muat ----------
const RAW = {};
for (const e of C.engines) RAW[e.id] = await loadEngine(C, e);

// ---------- 2. Live: rezim harian untuk membedah trade (opsional) ----------
let DREG = null, REG = null;
if (ONLINE) {
  try { DREG = await live.dailyRegime(); } catch (x) { W('kuning', 'pasar', 'Rezim harian BTC tidak terambil: ' + x.message, 'Cek akses Binance dari Actions (451 = diblok wilayah runner)'); }
  try { REG = await live.regimeScalp(C); } catch (x) { W('kuning', 'pasar', 'Kondisi pasar scalping tidak terambil: ' + x.message, null); }
}
out.regime = REG;
const regKey = t => (DREG && DREG[dayOf(t.asof)] ? DREG[dayOf(t.asof)].vol : null);
const arahKey = t => (DREG && DREG[dayOf(t.asof)] ? DREG[dayOf(t.asof)].arah : null);

// ---------- 2b. Arsip sinyal untuk mesin berformat history (sctnv4) ----------
// history.json mesin dipangkas (history.max_signals) dan bisa ter-reset bila unduhan Pages gagal saat deploy mesin.
// Monitor menyimpan semua sinyal yang pernah terlihat di site/arsip-<id>.json dan membacanya lagi dari Pages tiap build.
const ARSIP = {};
async function arsipMerge(e, R) {
  const catatan = [], url = `https://${C.owner}.github.io/${C.monitorRepo}/arsip-${e.id}.json?cb=${Date.now()}`;
  let prev = [], err = null;
  if (process.env.ARSIP_DIR) {
    const p = `${process.env.ARSIP_DIR}/arsip-${e.id}.json`;
    if (fs.existsSync(p)) prev = JSON.parse(fs.readFileSync(p, 'utf8')).signals ?? [];
  } else if (!process.env.LOCAL_DIR) {
    for (let i = 0; i < 3; i++) {
      err = null;
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
        if (r.ok) { prev = (await r.json()).signals ?? []; break; }
        if (r.status === 404) break;
        err = new Error('HTTP ' + r.status);
      } catch (x) { err = x; }
      await new Promise(res => setTimeout(res, 3000));
    }
    if (err) throw new Error(`arsip-${e.id}.json tidak terbaca (${err.message}): build dihentikan agar arsip sinyal tidak hilang`);
  }
  const demo = R.data?.mode === 'demo', fresh = demo ? [] : (R.hist ?? []);
  if (R.hist == null && prev.length) catatan.push(['kuning', 'history.json mesin tidak terbaca; penilaian memakai arsip monitor (sinyal terbaru bisa tertinggal)', 'Cek Pages mesin & workflow Scalp Analysis and Deploy']);
  if (fresh.length && prev.length) {
    const oldest = fresh.map(x => x.time).sort()[0], ids = new Set(fresh.map(x => x.id)), hilang = prev.filter(x => !ids.has(x.id) && x.time >= oldest);
    if (hilang.length) catatan.push(['kuning', `${hilang.length} sinyal yang pernah terlihat hilang dari history.json mesin padahal lebih baru dari sinyal tertua yang ada (history mesin ter-reset/terpotong). Arsip monitor menyimpannya`, 'Penyebab umum: langkah "Ambil history.json" di workflow mesin gagal lalu memulai riwayat kosong']);
  } else if (R.hist != null && !fresh.length && prev.length && !demo) catatan.push(['kuning', `history.json mesin kosong padahal arsip monitor berisi ${prev.length} sinyal (history mesin ter-reset). Arsip monitor dipakai`, null]);
  const signals = mergeArchive(prev, fresh);
  ARSIP[e.id] = signals;
  return { signals, catatan };
}

// ---------- 3. Per mesin ----------
const ALLSYM = new Set();
const FP = {}, SIGSET = {}, PEND = [], ALLT = {};
for (const e of C.engines) {
  const R = RAW[e.id];
  if (R.galat.length) W('merah', e.id, 'Data tidak terbaca: ' + R.galat.join('; '), 'Periksa nama repo di config.json atau secret MONITOR_TOKEN (repo privat)');
  const feeE = e.engineFeePct ?? C.engineFeePct;
  let arsipInfo = null;
  if (e.fmt === 'history') {
    arsipInfo = await arsipMerge(e, R);
    R.hist = arsipInfo.signals;
  }
  const fw = e.fmt === 'history' ? normHistory(R, e) : normForward(R, C);
  applyCost(fw.trades, feeE, C.costPct);
  // protokol forward = hash config terbaru; baris berhash lama tidak dicampur
  const hashes = [...new Set(fw.trades.map(t => t.hash).filter(Boolean))];
  let latest = [...fw.trades].filter(t => t.hash).sort((a, b) => b.asof - a.asof)[0]?.hash ?? null;
  if (e.fmt === 'history') {
    // sctnv4 tidak mencatat config_hash per sinyal: hash config.yaml saat ini dibandingkan dengan hash yang dikunci di config.json (pinHash)
    latest = cfgHash(R.cfgText);
    if (latest && !e.pinHash) W('info', e.id, `config.yaml sctnv4 saat ini berhash ${latest}. Kunci dengan mengisi "pinHash": "${latest}" pada config.json agar perubahan konfigurasi selama forward test terdeteksi`);
    if (latest && e.pinHash && latest !== e.pinHash) W('merah', e.id, `config.yaml sctnv4 berubah (hash ${latest}, dikunci ${e.pinHash}): forward test sebelum perubahan tidak sebanding`, 'Aturan: ganti konfigurasi = forward test mulai ulang. Naikkan "start" dan "pinHash" di config.json bila sengaja');
    if (!latest) W('info', e.id, 'config.yaml sctnv4 tidak terbaca (repo privat tanpa MONITOR_TOKEN?): perubahan konfigurasi tidak bisa dideteksi');
    if (R.data?.mode === 'demo') W('merah', e.id, 'Run terakhir sctnv4 bermode DEMO (data sintetis): sinyal demo tidak dimasukkan ke arsip');
    if (R.data?.errors && Object.keys(R.data.errors).length) W('kuning', e.id, `sctnv4 gagal mengambil data untuk: ${Object.keys(R.data.errors).join(', ')}`, 'Cek provider data (Binance Vision/OKX/Bybit) pada log Actions sctnv4');
    for (const m of arsipInfo.catatan) W(m[0], e.id, m[1], m[2] ?? null);
  }
  const all = fw.trades.filter(t => (!latest || !t.hash || t.hash === latest) && t.asof >= Date.parse(e.start));
  const lama = fw.trades.length - all.length;
  if (R.btSummary?.config_hash && latest && R.btSummary.config_hash !== latest) W('info', e.id, `Backtest dibuat dengan config_hash ${R.btSummary.config_hash}, forward test memakai ${latest}: konfigurasinya tidak sama`, 'Jalankan ulang workflow run-backtest agar sebanding');
  if (hashes.length > 1) W('kuning', e.id, `config_hash berganti ${hashes.length}x di jurnal (${hashes.join(', ')}). ${lama} baris berhash lama dikeluarkan dari penilaian`, 'Aturan mesin: ganti hash = forward test mulai ulang');
  const btRows = applyCost(normBacktest(R), feeE, C.costPct);
  const bsum = R.btSummary;
  for (const t of all) { ALLSYM.add(t.sym); if (t.status === 'WAITING' || t.status === 'OPEN') PEND.push({ e: e.id, t }); }
  FP[e.id] = btRows.length ? fingerprint(btRows) : null;
  SIGSET[e.id] = new Set(all.map(t => t.id));
  ALLT[e.id] = all;

  const closed = all.filter(isClosed), fp = perf(all), fl = funnel(all);
  const g = gates(fp, all, C), gb = gates(perf(btRows), btRows, C);
  const common = all.filter(t => t.asof >= Date.parse(C.commonStart) && C.commonSymbols.includes(t.sym));
  // jendela backtest bersama dihitung setelah semua mesin dimuat (lihat bawah)
  const blk = {
    id: e.id, nama: e.nama, start: e.start, fmt: e.fmt ?? 'csv', feePct: feeE, hash: latest, hashBt: bsum?.config_hash ?? null, sumber: R.sumber,
    fwd: { ...fp, curve: down(fp.curve || []), n: fp.n || 0 }, funnel: fl, gates: g,
    fwdLevel: levels(all), fwdCost: costCurve(all), fwdLO: closed.length >= 6 ? leaveOut(all) : null,
    dir: breakdown(all, t => t.dir), trig: breakdown(all, t => `${t.trig} / ${t.tf}`), sym: breakdown(all, t => t.sym),
    sesi: breakdown(all, sesi), skor: breakdown(all, skorBucket), hari: breakdown(all, hari), stop: breakdown(all, stopBucket),
    rezim: DREG ? breakdown(all.filter(regKey), regKey) : [], rezimArah: DREG ? breakdown(all.filter(arahKey), arahKey) : [],
    common: perf(common), commonN: common.length,
    bt: btRows.length ? {
      meta: { generated: bsum?.generated ?? null, period: bsum?.period ?? null, symbols: bsum?.symbols ?? [], days: bsum?.days ?? null, demo: !!bsum?.demo, hash: bsum?.config_hash ?? null, engineStats: bsum?.stats ? { n: bsum.stats.n, avg: bsum.stats.avg_r, pf: bsum.stats.profit_factor } : null },
      ...(() => { const p = perf(btRows); return { ...p, curve: down(p.curve || []) }; })(), funnel: funnel(btRows), level: levels(btRows), cost: costCurve(btRows), lo: leaveOut(btRows), gates: gb,
      dir: breakdown(btRows, t => t.dir), trig: breakdown(btRows, t => `${t.trig} / ${t.tf}`), sym: breakdown(btRows, t => t.sym), sesi: breakdown(btRows, sesi), skor: breakdown(btRows, skorBucket), hari: breakdown(btRows, hari), stop: breakdown(btRows, stopBucket),
      rezim: DREG ? breakdown(btRows.filter(regKey), regKey) : [], rezimArah: DREG ? breakdown(btRows.filter(arahKey), arahKey) : [],
      _rows: btRows,
    } : null,
    jurnal: [...all].sort((a, b) => b.asof - a.asof).slice(0, 400).map(t => ({ id: t.id, w: iso(t.asof).slice(0, 16), s: t.sym, d: t.dir, tr: t.trig, tf: t.tf, sk: t.score, sg: t.sig, en: t.entry, sl: t.stop, tp1: t.tp1, st: t.status, oc: t.outcome, r: t.r == null ? null : +t.r.toFixed(3), why: t.reason, fx: t.fill ? iso(t.fill).slice(5, 16) : null, ex: t.exit ? iso(t.exit).slice(0, 16).replace('T', ' ') : null })),
    tanpaEval: fw.tanpaEval.length, _all: all, _fw: fw,
  };
  out.engines.push(blk);
}

// ---------- 4. Jendela backtest bersama + perbandingan setara ----------
const btE = out.engines.filter(e => e.bt);
if (btE.length > 1) {
  const lo = Math.max(...btE.map(e => Date.parse(e.bt.meta.period?.[0] ?? 0))), hi = Math.min(...btE.map(e => Date.parse(e.bt.meta.period?.[1] ?? 9e15)));
  out.btWindow = { from: iso(lo), to: iso(hi) };
  for (const e of btE) {
    const rows = e.bt._rows.filter(t => t.asof >= lo && t.asof <= hi && C.commonSymbols.includes(t.sym)), p = perf(rows);
    e.btCommon = { n: p.n, avg: p.avg, total: p.total, pf: p.pf, win: p.winRate, ci: p.ci, maxDD: p.maxDD };
  }
}

// ---------- 5. Peringatan per mesin ----------
for (const e of out.engines) {
  const f = e.fwd, fl = e.funnel, bt = e.bt, R = RAW[e.id], fw = e._fw;
  // kesegaran
  const upd = R.forward?.updated ? Date.parse(R.forward.updated) : null;
  if (upd != null) {
    const age = (NOW - upd) / H;
    if (age > C.staleHours) {
      const cfgE = C.engines.find(x => x.id === e.id), cm = cfgE.fmt === 'history' ? null : await lastCommitMs(C, cfgE, 'output/forward_test.json'), cage = cm == null ? null : (NOW - cm) / H;
      if (cage != null && cage <= C.staleHours * 2) W('info', e.id, `forward_test.json berumur ${age.toFixed(0)} jam tetapi di-commit ${cage.toFixed(0)} jam lalu: workflow hidup (tidak ada perubahan)`);
      else W(age > 12 ? 'merah' : 'kuning', e.id, `forward_test.json terakhir diperbarui ${age.toFixed(0)} jam lalu (workflow terjadwal tiap jam atau 15 menit)`, 'Buka tab Actions repo mesin: apakah run-analysis gagal atau dinonaktifkan GitHub (repo tidak aktif 60 hari)?');
    }
  }
  if (e.tanpaEval > 0) {
    const old = fw.tanpaEval.filter(x => NOW - x.asof > 2 * H).length;
    if (old) W('kuning', e.id, `${old} sinyal ada di signal_log.csv tetapi belum ada di forward_test.json (evaluator tertinggal/gagal)`, 'Cek langkah "Evaluasi forward test" di Actions');
  }
  if (!f.n) W('info', e.id, 'Belum ada trade selesai di forward test: tidak ada yang bisa dinilai. Jangan menyimpulkan apa pun.');
  else if (f.n < 30) W('info', e.id, `Sampel forward sangat kecil (${f.n} trade selesai, ${f.hari} hari). Win rate, R/trade, PF belum bermakna`, 'Tunggu; jangan ubah mesin selama forward test');
  // corong
  const dec = fl.CLOSED + fl.OPEN + fl.CANCELLED;
  if (dec >= 5 && fl.fillRate < 0.5) {
    const top = Object.entries(fl.why).sort((a, b) => b[1] - a[1])[0];
    W('kuning', e.id, `Hanya ${pct(fl.fillRate)} sinyal yang terisi (${fl.CLOSED + fl.OPEN}/${dec}). Penyebab batal terbanyak: "${top?.[0] ?? '-'}" (${top?.[1] ?? 0}x)`, 'Entry limit terlalu jauh dari harga: harga lebih dulu menuju TP1. Pertimbangkan batas jarak entry (mis. maks 0,5-0,75R dari harga) atau entry pasar bila trigger sudah terkonfirmasi');
  }
  const pl = fl.bySig.find(x => x.k === 'PENDING LIMIT'), ez = fl.bySig.find(x => x.k === 'ENTRY ZONE');
  if (pl && pl.terisi + pl.batal >= 5 && ez && ez.terisi + ez.batal >= 1) W('info', e.id, `Fill rate PENDING LIMIT ${pct(pl.fill)} vs ENTRY ZONE ${pct(ez.fill)}: nilai edge hanya berlaku untuk sinyal yang benar-benar terisi`);
  // sinyal berulang
  const key = t => [t.sym, t.dir, t.entry].join('|'), seen = {};
  for (const t of e._all) (seen[key(t)] ??= []).push(t);
  const rep = Object.values(seen).filter(v => v.length > 1);
  if (rep.length) W('info', e.id, `${rep.length} level entry diulang oleh >1 sinyal (mis. ${rep[0][0].sym} ${rep[0][0].dir} @${rep[0][0].entry}, ${rep[0].length}x). Dihitung sebagai trade terpisah padahal satu ide`, 'Lihat "Level unik" untuk N efektif');
  // scalping murni?
  if (f.hold && f.hold.gt24 > 0.15) W('kuning', e.id, `${pct(f.hold.gt24)} trade ditahan > 24 jam (median ${f2(f.hold.med, 1)} jam): bukan scalping murni`, 'Pertimbangkan max_hold_hours lebih pendek untuk uji scalping');
  if (f.n >= 10 && f.stopMed != null && f.stopMed < 0.85) W('info', e.id, `Stop median ${f2(f.stopMed)}%: biaya ${C.costPct}% = ${f2(C.costPct / f.stopMed)}R per trade. Edge harus > itu`);
  // biaya
  const cc = e.fwdCost;
  if (f.n >= 30 && cc && cc.be < C.costPct * 2) W('kuning', e.id, `Biaya impas forward ${f2(cc.be, 3)}% (asumsi ${C.costPct}%): selisih kecil fee/slippage menghapus profit`, 'Ukur fee tier & slippage nyata di bursa sebelum uang sungguhan');
  // backtest
  if (bt) {
    if (bt.meta.demo) W('merah', e.id, 'Backtest bertanda DEMO (data sintetis): abaikan angkanya');
    const lo = bt.lo;
    if (lo && bt.n >= 30 && (lo.restTotal <= 0.25 * lo.total || lo.restAvg <= 0)) W('kuning', e.id, `Backtest bergantung pada ${lo.top.join(' + ')}: total ${f2(lo.total, 1)}R, tanpa keduanya ${f2(lo.restTotal, 1)}R (R/trade ${f2(lo.restAvg)}, n=${lo.restN})`, 'Edge tampak spesifik koin, bukan sistem. Uji pada koin/periode lain sebelum percaya');
    const sh = bt.dir.find(x => x.k === 'SHORT'), lg = bt.dir.find(x => x.k === 'LONG');
    if (sh && bt.n > 0 && sh.n / bt.n > 0.85) W('kuning', e.id, `Backtest ${pct(sh.n / bt.n)} SHORT (LONG n=${lg?.n ?? 0}, R/trade ${f2(lg?.avg)}): periode ini kemungkinan pasar turun. Mesin belum teruji di pasar naik/sideways`, 'Jangan percaya edge sampai ada sampel LONG memadai');
    const risk = C.riskPerTradePct ?? 1;
    if (bt.maxDD >= 15 || (bt.total > 0 && bt.maxDD > 0.4 * bt.total)) W('kuning', e.id, `Max drawdown backtest ${f2(bt.maxDD, 1)}R vs total ${f2(bt.total, 1)}R. Dengan risiko ${risk}%/trade itu kira-kira -${f2(bt.maxDD * risk, 0)}% ekuitas (tanpa compounding; posisi bersamaan memperburuk)`, 'Turunkan risiko per trade atau batasi posisi bersamaan sebelum uang nyata');
    if (bt.level && bt.level.dup > 0.05 * bt.n) W('info', e.id, `Backtest: ${bt.n} baris = ${bt.level.u} level unik (N efektif ${f2(bt.level.neff, 0)})`);
    if (bt.top3Share != null && bt.top3Share > 0.5) W('kuning', e.id, `Backtest: 3 trade teratas = ${pct(bt.top3Share)} dari total untung`, `Tanpa 3 trade itu R/trade = ${f2(bt.avgEx3)}`);
    if (f.n >= 30) {
      const dv = f.avg - bt.avg;
      if (dv < -0.25) W('merah', e.id, `Forward (${f2(f.avg)}R/trade) jauh di bawah backtest (${f2(bt.avg)}R/trade): backtest tampak overfit`, 'Percayai forward, bukan backtest');
    }
    if (bt.funnel.fillRate != null && fl.fillRate != null && dec >= 8 && fl.fillRate < bt.funnel.fillRate - 0.25) W('kuning', e.id, `Fill rate forward ${pct(fl.fillRate)} jauh di bawah backtest ${pct(bt.funnel.fillRate)}`, 'Backtest terlalu optimis soal pengisian limit');
  }
  if (e.fmt === 'history') {
    W('info', e.id, 'sctnv4 mencatat sinyal limit (menunggu retest) dan entry-zone tanpa penanda, dan simulatornya menganggap entry terisi saat sinyal. Corong "terisi" di monitor untuk sctnv4 = 100% secara definisi, bukan terukur', 'Lihat bagian Uji silang: monitor memeriksa dengan candle 1 menit apakah entry benar-benar tersentuh');
  }
  if (f.n >= 10 && f.maxStreak >= 8) W('info', e.id, `Rentetan kalah terpanjang ${f.maxStreak} trade berturut-turut`);
}

// ---------- 6. Peringatan lintas mesin ----------
for (const a of out.engines) for (const b of out.engines) {
  if (a.id >= b.id || !a.bt || !b.bt) continue;
  if (FP[a.id] === FP[b.id] && FP[a.id]) W('kuning', `${a.id}=${b.id}`, `Backtest ${a.id} dan ${b.id} berisi daftar trade yang IDENTIK (${FP[a.id].split(':')[0]} trade): perubahan di ${b.id} tidak mengubah sinyal. Keduanya bukan bukti independen`, 'Bandingkan hanya bila logika sinyal memang berbeda');
}
for (const a of out.engines) for (const b of out.engines) {
  if (a.id >= b.id) continue;
  const A = SIGSET[a.id], B = SIGSET[b.id];
  if (A.size < 3 || B.size < 3) continue;
  const inter = [...A].filter(x => B.has(x)).length, ov = inter / Math.min(A.size, B.size);
  out.silang[`${a.id}|${b.id}`] = { inter, a: A.size, b: B.size, ov };
  if (ov >= 0.8) W('kuning', `${a.id}~${b.id}`, `${pct(ov)} sinyal forward ${a.id} dan ${b.id} sama persis (${inter} signal_id): trade yang sama terhitung dua kali, bukan dua sampel`, 'Jangan menjumlah sampel kedua mesin. Anggap satu mesin sampai logikanya benar-benar beda');
}
const wins = out.engines.filter(e => e.bt?.meta.period).map(e => e.bt.meta.period[0].slice(0, 10) + '→' + e.bt.meta.period[1].slice(0, 10));
if (new Set(wins).size > 1) W('info', 'backtest', `Jendela backtest tiap mesin berbeda (${wins.join(' | ')}). Gunakan tabel "jendela & koin bersama" untuk membandingkan`);
W('info', 'monitor', `Penilaian: forward test = bukti; backtest = hipotesis. Win rate = R>0 setelah biaya ${C.costPct}% pulang-pergi (mesin mengasumsikan ${C.engineFeePct}%). CI95 memakai bootstrap per hari karena sinyal antar koin berkorelasi`);
W('info', 'monitor', 'Memilih mesin "terbaik" dari 3 kandidat adalah perbandingan ganda: tetapkan kriteria lolos (gerbang di atas) SEBELUM melihat hasil, dan jangan memilih berdasarkan backtest');

// ---------- 7. Lapisan live ----------
const pend = [];
if (ONLINE && PEND.length) {
  const px = await live.prices(PEND.map(x => x.t.sym)).catch(() => ({}));
  for (const { e, t } of PEND) {
    const p = px[t.sym.replace('/', '')] ?? null, sg = t.dir === 'LONG' ? 1 : -1;
    const row = { e, s: t.sym, d: t.dir, sg: t.sig, st: t.status, w: iso(t.asof).slice(0, 16), en: t.entry, sl: t.stop, tp1: t.tp1, tp2: t.tp2, px: p, dist: p ? (p - t.entry) / t.entry * 100 : null, sisaH: Math.max(0, (t.asof + C.engineEval.expiryH * H - NOW) / H), ket: '' };
    if (p != null) {
      if (t.status === 'WAITING') {
        if ((p - t.tp1) * sg >= 0) row.ket = 'BASI: harga sudah melewati TP1 sebelum entry terisi (akan dibatalkan evaluator)';
        else if ((p - t.stop) * sg <= 0) row.ket = 'BASI: harga sudah melewati stop';
        else row.ket = row.dist * sg > 0 ? 'harga sudah lewat entry ke arah trade' : 'menunggu retest ke entry';
      } else { const d = Math.abs(t.entry - t.stop); row.floatR = ((p - t.entry) * sg / d); row.ket = 'posisi berjalan'; }
    }
    pend.push(row);
  }
} else for (const { e, t } of PEND) pend.push({ e, s: t.sym, d: t.dir, sg: t.sig, st: t.status, w: iso(t.asof).slice(0, 16), en: t.entry, sl: t.stop, tp1: t.tp1, px: null, dist: null, ket: 'harga live tidak tersedia' });
out.pending = pend;
const basi = pend.filter(x => x.ket.startsWith('BASI')).length;
if (basi) W('info', 'sinyal', `${basi} sinyal menunggu sudah basi (harga lebih dulu menuju target). Jangan dipasang manual`);

if (ONLINE && C.audit.enabled) {
  for (const e of out.engines) {
    try {
      e.audit = await live.auditEngine(e._all, C, C.engines.find(x => x.id === e.id));
      const a = e.audit;
      if (e.fmt === 'history') {
        const fa = e.audit.fill;
    if (fa && fa.n >= 5) {
      const lim = fa.limit / fa.n;
      if (lim >= 0.2 && fa.batal / fa.n >= 0.1) W('kuning', e.id, `Uji silang 1 menit: ${fa.limit}/${fa.n} trade selesai sctnv4 ternyata sinyal limit (harga belum di entry saat sinyal) dan ${fa.batal} di antaranya tidak pernah terisi (TP1 lebih dulu/kedaluwarsa) tetapi tetap dihitung mesin. R total mesin ${f2(fa.rEng, 1)}R vs sadar-pengisian ${f2(fa.rAware, 1)}R (n=${fa.nAware})`, 'Edge sctnv4 di monitor bisa terlalu optimis. Nilai dari kolom sadar-pengisian, dan pertimbangkan agar mesin mencatat limit vs entry-zone serta mengecek pengisian');
      else if (fa.nAware < fa.n) W('info', e.id, `Uji silang 1 menit: ${fa.n - fa.nAware}/${fa.n} trade selesai sctnv4 tidak terisi menurut candle 1 menit. R total mesin ${f2(fa.rEng, 1)}R vs sadar-pengisian ${f2(fa.rAware, 1)}R`);
    }
      }
      if (a.n >= 5 && a.beda / a.n > 0.2) W(a.beda / a.n > 0.4 ? 'merah' : 'kuning', e.id, `Uji silang candle 1 menit: ${a.beda}/${a.n} trade hasilnya BEDA dari simulator mesin (candle 15m/5m). Selisih R rata-rata ${f2(a.dRrata)}`, 'Simulator 15m ambigu pada candle yang menyentuh stop & TP sekaligus. Lihat rincian di bagian Uji silang');
      if (a.gagal.length) W('info', e.id, `Uji silang: candle 1m tidak terambil untuk ${a.gagal.join(', ')} (koin di luar Binance?)`);
    } catch (x) { W('kuning', e.id, 'Uji silang gagal: ' + x.message); }
  }
}
{
  const uni = new Set();
  for (const e of out.engines) for (const s of RAW[e.id].universe?.symbols ?? []) uni.add(s);
  if (uni.size) {
    const bad = ONLINE ? await live.universeCheck([...uni], C).catch(() => []) : live.universeStatic([...uni], C);
    out.universeBad = bad;
    if (bad.length) W('kuning', 'universe', `${bad.length} koin di universe scanner bukan aset kripto normal: ${bad.map(b => b.s.split('/')[0]).join(', ')}`, 'Tambahkan ke exclude di config/symbols.yaml mesin (saham/ETF tokenisasi punya jam pasar & celah harga; mirip-stablecoin tidak bisa di-scalp)');
  }
}
if (REG && REG.status !== 'NORMAL') W(REG.status === 'EKSTREM' ? 'kuning' : 'info', 'pasar', `Kondisi pasar ${REG.status}: ${REG.flags.join('; ') || '-'}`, 'Pasar sepi = jebakan chop & biaya menggerus; volatilitas ekstrem = stop tersapu. Pertimbangkan tidak trading');

// ---------- 8. Ringkas & tulis ----------
for (const e of out.engines) {
  const f = e.fwd;
  e.verdict = !f.n ? 'BELUM ADA TRADE' : e.gates.layak ? 'LAYAK UJI UANG NYATA (RISIKO KECIL)' : f.n < 30 ? 'SAMPEL TERLALU KECIL' : 'BELUM LAYAK';
  if (e.bt) delete e.bt._rows;
  delete e._all; delete e._fw;
}
const order = { merah: 0, kuning: 1, info: 2 };
out.warnings.sort((a, b) => order[a.lvl] - order[b.lvl]);
out.laporan = buildReport(out, C);

// ---------- 9. Riwayat laporan harian (kolom "Laporan untuk Claude"; tanggal lapor disimpan di Firebase oleh index.html) ----------
let LG = [];
if (!process.env.LOCAL_DIR) {
  const r = await fetch(`https://${C.owner}.github.io/${C.monitorRepo}/laporan-log.json?cb=${Date.now()}`, { signal: AbortSignal.timeout(30000) });
  if (r.ok) LG = await r.json();
  else if (r.status !== 404) throw new Error('laporan-log.json HTTP ' + r.status + ': build dihentikan agar riwayat laporan tidak hilang');
}
if (process.env.LOG_IN) LG = JSON.parse(fs.readFileSync(process.env.LOG_IN, 'utf8'));
const hariWib = wibDay(Date.parse(out.updated));
const lg = buildLog(LG, { hari: hariWib, updated: out.updated, md: out.laporan, recon: d => recon(d, ALLT, C, out.updated) });
out.hariIni = hariWib; out.hariId = lg.hariId; out.log = lg.log;
fs.mkdirSync('site', { recursive: true });
fs.writeFileSync('site/laporan-log.json', JSON.stringify(lg.LG));
for (const [id, signals] of Object.entries(ARSIP)) fs.writeFileSync(`site/arsip-${id}.json`, JSON.stringify({ engine: id, updated: out.updated, signals }));
fs.copyFileSync(new URL('../index.html', import.meta.url), 'site/index.html');
fs.writeFileSync('site/data.json', JSON.stringify(out));
fs.writeFileSync('site/laporan.md', out.laporan);
fs.writeFileSync('site/.nojekyll', '');
console.log('OK', out.engines.length, 'mesin,', out.warnings.length, 'warning');
