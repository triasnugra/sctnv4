// node --test test/   (tanpa dependensi, tanpa internet)
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCSV, wilson, clusterBootstrap, toMs } from '../scripts/lib.mjs';
import { perf, funnel, levels, gates, leaveOut, costCurve } from '../scripts/metrics.mjs';
import { simulate } from '../scripts/sim.mjs';
import { applyCost } from '../scripts/load.mjs';

const T = (o) => ({ status: 'CLOSED', sym: 'A/USDT', dir: 'SHORT', entry: 100, stop: 101, tp1: 98, stopPct: 1, asof: Date.parse('2026-11-01T00:00:00Z'), fill: Date.parse('2026-11-01T00:00:00Z'), exit: Date.parse('2026-11-01T02:00:00Z'), outcome: 'LOSS', ...o });

test('parseCSV: kutip, koma di dalam sel, baris kosong', () => {
  const r = parseCSV('a,b,c\n1,"x,y",3\n4,"he said ""hi""",6\n');
  assert.equal(r.length, 2); assert.equal(r[0].b, 'x,y'); assert.equal(r[1].b, 'he said "hi"');
});
test('toMs: waktu tanpa zona dianggap UTC, spasi diganti T', () => {
  assert.equal(toMs('2026-11-19 19:27:37+00:00'), Date.parse('2026-11-19T19:27:37Z'));
  assert.equal(toMs('2026-11-19 19:27:37'), Date.parse('2026-11-19T19:27:37Z'));
  assert.equal(toMs(''), null);
});
test('applyCost: R mesin (biaya 0,10%) dibalik ke kotor lalu dikurangi biaya monitor', () => {
  const t = [{ rEng: 1.0, stopPct: 1 }]; applyCost(t, 0.10, 0.15);
  assert.ok(Math.abs(t[0].rGross - 1.1) < 1e-9); assert.ok(Math.abs(t[0].r - 0.95) < 1e-9);
});
test('perf: win, PF, drawdown, streak', () => {
  const rows = [1, -1, -1, 2, -1].map((r, i) => T({ r, exit: Date.parse('2026-11-01T00:00:00Z') + i * 36e5, asof: Date.parse('2026-11-01T00:00:00Z') + i * 864e5 }));
  const p = perf(rows);
  assert.equal(p.n, 5); assert.equal(p.wins, 2); assert.equal(p.maxStreak, 2);
  assert.ok(Math.abs(p.pf - 3 / 3) < 1e-9); assert.ok(Math.abs(p.maxDD - 2) < 1e-9); assert.equal(p.ci, null); // <10 hari
});
test('perf: kosong tidak melempar', () => assert.deepEqual(perf([]), { n: 0 }));
test('clusterBootstrap deterministik dan memuat rata-rata', () => {
  const g = Array.from({ length: 20 }, (_, i) => [i % 2 ? 1 : 0.2, 0.5]);
  const a = clusterBootstrap(g), b = clusterBootstrap(g);
  assert.deepEqual(a, b); assert.ok(a[0] < 0.65 && a[1] > 0.55);
});
test('wilson', () => { const w = wilson(50, 100); assert.ok(w[0] < 0.5 && w[1] > 0.5 && w[0] > 0.39); });
test('funnel: fill rate hanya dari yang sudah diputuskan', () => {
  const f = funnel([T({}), T({ status: 'CANCELLED', reason: 'x' }), T({ status: 'WAITING' }), T({ status: 'OPEN' })]);
  assert.equal(f.CLOSED, 1); assert.ok(Math.abs(f.fillRate - 2 / 3) < 1e-9);
});
test('levels: level sama dihitung satu', () => {
  const l = levels([T({ r: 1 }), T({ r: 1 }), T({ r: -1, entry: 5 })]);
  assert.equal(l.u, 2); assert.equal(l.dup, 1);
});
test('leaveOut: membuang koin teratas', () => {
  const rows = [T({ sym: 'A', r: 5 }), T({ sym: 'B', r: 4 }), T({ sym: 'C', r: -1 }), T({ sym: 'D', r: -1 })];
  const lo = leaveOut(rows, 2); assert.deepEqual(lo.top, ['A', 'B']); assert.equal(lo.restTotal, -2);
});
test('costCurve: biaya impas membuat R = 0', () => {
  const rows = [T({ rGross: 0.3, r: 0.3 }), T({ rGross: 0.1, r: 0.1 })];
  const c = costCurve(rows); const at = rows.reduce((s, t) => s + t.rGross - c.be / t.stopPct, 0);
  assert.ok(Math.abs(at) < 1e-9);
});
test('gates: butuh dua arah', () => {
  const C = { minTrades: 1, minWeeks: 0, minPF: 1, minPerSide: 2, costPct: 0.15 };
  const rows = [T({ r: 1, dir: 'SHORT' })]; const g = gates({ n: 1, minggu: 1, ci: [0.1, 1], pf: 2 }, rows, C);
  assert.equal(g.layak, false); assert.equal(g.list[4][0], false);
});
test('simulate: SHORT kena stop di candle yang sama dengan TP1 -> stop dulu', () => {
  const s = { dir: 'SHORT', statusSig: 'ENTRY ZONE', asof: 0, entry: 100, stop: 101, tp1: 98, tp2: 96, be: 99.9, f: 60, stopPct: 1 };
  const r = simulate(s, [{ t: 0, h: 101.2, l: 97.5, c: 99 }], { fee: 0.1, expiryH: 24, holdH: 72 });
  assert.equal(r.outcome, 'LOSS'); assert.equal(r.r, -1.1);
});
test('simulate: limit batal bila TP1 tercapai sebelum entry', () => {
  const s = { dir: 'SHORT', statusSig: 'PENDING LIMIT', asof: 0, entry: 102, stop: 103, tp1: 98, tp2: 96, be: 101.9, f: 60, stopPct: 1 };
  const r = simulate(s, [{ t: 0, h: 100, l: 97, c: 98 }], { fee: 0.1, expiryH: 24, holdH: 72 });
  assert.equal(r.status, 'CANCELLED');
});
