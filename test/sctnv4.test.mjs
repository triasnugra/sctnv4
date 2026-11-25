// node --test test/   (tanpa dependensi, tanpa internet) - adapter sctnv4
import test from 'node:test';
import assert from 'node:assert/strict';
import { normHistory, mergeArchive, cfgHash, applyCost } from '../scripts/load.mjs';
import { simulatePy, simulatePyFill } from '../scripts/sim.mjs';
import { skorBucket, perf, isClosed } from '../scripts/metrics.mjs';

const E = { id: 'sctnv4', fmt: 'history', quote: 'USDT', tp1FractionPct: 60 };
const S = (o) => ({ id: 'BTC-1', symbol: 'BTC', direction: 'long', trigger: 'T1', time: '2026-11-25T10:00:00+00:00', entry: 100, stop: 99, tp1: 101, tp2: 102, score: 78, status: 'TP2', r: 1.0, closed_at: '2026-11-25T12:00:00+00:00', ...o });

test('normHistory: simbol, arah, status, outcome, skala skor', () => {
  const { trades } = normHistory({ hist: [S({}), S({ id: 'b', status: 'SL', r: -1.16 }), S({ id: 'c', status: 'OPEN', closed_at: null, r: 0 }), S({ id: 'd', status: 'TIME' }), S({ id: 'e', status: 'INVALID', closed_at: null })] }, E);
  assert.equal(trades[0].sym, 'BTC/USDT'); assert.equal(trades[0].dir, 'LONG'); assert.equal(trades[0].status, 'CLOSED'); assert.equal(trades[0].outcome, 'TP2');
  assert.equal(trades[1].outcome, 'LOSS'); assert.equal(trades[2].status, 'OPEN'); assert.equal(trades[2].rEng, null);
  assert.equal(trades[3].outcome, 'TIMEOUT'); assert.equal(trades[4].status, 'CANCELLED');
  assert.ok(Math.abs(trades[0].stopPct - 1) < 1e-9);
});
test('applyCost sctnv4: biaya mesin 0,16% dibalik lalu biaya monitor 0,15%', () => {
  const t = normHistory({ hist: [S({ status: 'SL', r: -1.16 })] }, E).trades; applyCost(t, 0.16, 0.15);
  assert.ok(Math.abs(t[0].rGross + 1) < 1e-9); assert.ok(Math.abs(t[0].r + 1.15) < 1e-9);
});
test('skorBucket: skala 0-10 dan 0-100', () => {
  assert.equal(skorBucket({ score: 9.2 }), 'skor >= 9'); assert.equal(skorBucket({ score: 78 }), 'skor 7-8'); assert.equal(skorBucket({ score: 93 }), 'skor >= 9'); assert.equal(skorBucket({ score: 5 }), 'skor <= 6');
});
test('mergeArchive: sinyal selesai tidak berubah, sinyal berjalan diperbarui, yang terpangkas tetap ada', () => {
  const prev = [S({ id: 'a', time: '2026-11-25T01:00:00+00:00' }), S({ id: 'b', status: 'OPEN', closed_at: null, r: 0, time: '2026-11-25T02:00:00+00:00' })];
  const fresh = [S({ id: 'a', status: 'SL', r: -2 }), S({ id: 'b', status: 'SL', r: -1.1, time: '2026-11-25T02:00:00+00:00' }), S({ id: 'c', time: '2026-11-25T03:00:00+00:00' })];
  const m = mergeArchive(prev, fresh);
  assert.deepEqual(m.map(x => x.id), ['a', 'b', 'c']); assert.equal(m[0].status, 'TP2'); assert.equal(m[1].status, 'SL');
  assert.equal(mergeArchive(prev, []).length, 2);
});
test('cfgHash stabil terhadap CRLF & spasi akhir baris, berubah bila isi berubah', () => {
  assert.equal(cfgHash('a: 1\nb: 2\n'), cfgHash('a: 1  \r\nb: 2\r\n')); assert.notEqual(cfgHash('a: 1'), cfgHash('a: 2')); assert.equal(cfgHash(null), null);
});
const C1 = (t, h, l, c) => ({ t: t * 6e4, h, l, c });
const ev = { fee: 0.16, holdH: 6 };
test('simulatePy: stop dan TP1 di candle yang sama -> stop dulu; biaya = fee/stopPct', () => {
  const s = { dir: 'LONG', asof: 0, entry: 100, stop: 99, tp1: 101, tp2: 102, f: 60, stopPct: 1 };
  const r = simulatePy(s, [C1(1, 101.5, 98.5, 100)], ev); assert.equal(r.outcome, 'LOSS'); assert.ok(Math.abs(r.r + 1.16) < 1e-9);
});
test('simulatePy: TP1 lalu TP2 = 0,6*1 + 0,4*2 - biaya; candle sebelum sinyal diabaikan', () => {
  const s = { dir: 'LONG', asof: 5 * 6e4, entry: 100, stop: 99, tp1: 101, tp2: 102, f: 60, stopPct: 1 };
  const r = simulatePy(s, [C1(1, 90, 50, 60), C1(5, 101.2, 100, 101), C1(6, 102.5, 100.5, 102)], ev);
  assert.equal(r.outcome, 'TP2'); assert.ok(Math.abs(r.r - (0.6 + 0.8 - 0.16)) < 1e-9);
});
test('simulatePy: time stop 6 jam sejak sinyal -> mark-to-market', () => {
  const s = { dir: 'SHORT', asof: 0, entry: 100, stop: 101, tp1: 98, tp2: 96, f: 60, stopPct: 1 };
  const r = simulatePy(s, [C1(1, 100.2, 99.5, 99.5), C1(360, 100.1, 99.0, 99.0)], ev); assert.equal(r.outcome, 'TIMEOUT'); assert.ok(Math.abs(r.r - (1 - 0.16)) < 1e-9);
});
test('simulatePyFill: sinyal limit yang TP1-nya tercapai tanpa menyentuh entry -> tidak terisi', () => {
  const s = { dir: 'LONG', asof: 0, entry: 100, stop: 99, tp1: 102, tp2: 103, f: 60, stopPct: 1 };
  const cs = [C1(0, 101, 100.6, 100.8), C1(1, 102.5, 100.7, 102)];
  const r = simulatePyFill(s, cs, ev); assert.equal(r.kind, 'limit'); assert.equal(r.filled, false);
});
test('simulatePyFill: entry tersentuh saat sinyal -> zone, hasil sama dengan simulatePy', () => {
  const s = { dir: 'LONG', asof: 30e3, entry: 100, stop: 99, tp1: 101, tp2: 102, f: 60, stopPct: 1 };
  const cs = [C1(0, 100.5, 99.8, 100.2), C1(1, 98.5, 98.0, 98.2)];
  const a = simulatePyFill(s, cs, ev), b = simulatePy(s, cs, ev); assert.equal(a.kind, 'zone'); assert.equal(a.outcome, b.outcome); assert.equal(a.r, b.r);
});
test('perf memakai hanya trade CLOSED sctnv4', () => {
  const t = normHistory({ hist: [S({}), S({ id: 'o', status: 'OPEN', closed_at: null })] }, E).trades; applyCost(t, 0.16, 0.15);
  assert.equal(perf(t).n, 1); assert.equal(t.filter(isClosed).length, 1);
});
