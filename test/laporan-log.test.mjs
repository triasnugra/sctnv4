// node --test test/   (tanpa internet)
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLog, recon, logId } from '../scripts/laporan-log.mjs';

const C = { costPct: 0.15, engineEval: { expiryH: 24, holdH: 72 } };
const T = o => ({ status: 'CLOSED', sym: 'A/USDT', dir: 'LONG', stopPct: 1, asof: Date.parse('2026-11-20T01:00:00Z'), fill: Date.parse('2026-11-20T01:30:00Z'), exit: Date.parse('2026-11-20T03:00:00Z'), outcome: 'TP2', r: 1.5, reason: '', ...o });

test('logId: 12 digit, berakhiran 0001 (beda dari monitortn yang 0000)', () => {
  assert.equal(logId('2026-11-25'), '202611250001');
  assert.match(logId('2026-11-25'), /^[0-9]{12}$/);
});
test('buildLog: riwayat kosong -> 3 hari rekonstruksi + hari ini, md hari ini dikosongkan di log', () => {
  const r = buildLog([], { hari: '2026-11-25', updated: '2026-11-25T06:00:00.000Z', md: 'LIVE', recon: d => 'R ' + d });
  assert.deepEqual(r.LG.map(x => x.d), ['2026-11-22', '2026-11-23', '2026-11-24', '2026-11-25']);
  assert.ok(r.LG.slice(0, 3).every(x => x.rekon));
  assert.equal(r.hariId, '202611250001');
  assert.equal(r.log.at(-1).md, ''); assert.equal(r.LG.at(-1).md, 'LIVE');
});
test('buildLog: snapshot asli tidak ditimpa, hari lama (>4 hari) dibuang, laporan hari ini diperbarui', () => {
  const old = [
    { id: '202611200001', d: '2026-11-20', t: 'x', md: 'lama' },
    { id: '202611240001', d: '2026-11-24', t: '2026-11-24T10:00:00.000Z', md: 'ASLI' },
    { id: '202611250001', d: '2026-11-25', t: '2026-11-25T01:00:00.000Z', md: 'kemarin-siang' },
  ];
  const r = buildLog(old, { hari: '2026-11-25', updated: '2026-11-25T06:00:00.000Z', md: 'BARU', recon: d => 'R ' + d });
  assert.ok(!r.LG.some(x => x.d === '2026-11-20'));
  assert.equal(r.LG.find(x => x.d === '2026-11-24').md, 'ASLI');
  assert.equal(r.LG.find(x => x.d === '2026-11-24').rekon, undefined);
  assert.equal(r.LG.find(x => x.d === '2026-11-25').md, 'BARU');
  assert.equal(r.LG.filter(x => x.d === '2026-11-25').length, 1);
});
test('recon: trade yang selesai setelah akhir hari (WIB) dianggap belum selesai', () => {
  // hari 2026-11-20 WIB berakhir 2026-11-20T16:59:59Z; trade selesai 11-20 03:00Z masuk, yang selesai 11-21 tidak
  const ALLT = { sctn: [T({}), T({ asof: Date.parse('2026-11-20T10:00:00Z'), fill: Date.parse('2026-11-20T11:00:00Z'), exit: Date.parse('2026-11-21T02:00:00Z') })] };
  const md = recon('2026-11-20', ALLT, C, '2026-11-25T06:00:00.000Z');
  assert.match(md, /REKONSTRUKSI/);
  assert.match(md, /\| sctn \| 2 \| 1 \|/); // 2 sinyal, 1 selesai
});
