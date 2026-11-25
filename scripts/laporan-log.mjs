// Riwayat laporan harian untuk kolom "Laporan untuk Claude" (pola sama dengan monitortn).
// Satu laporan per tanggal (WIB). Laporan hari ini terus diperbarui; mulai besok ia membeku dan tampil 3 hari.
// Tanggal yang terlewat (monitor belum jalan) direkonstruksi dari jurnal, diberi label REKONSTRUKSI.
// ID dokumen Firebase = YYYYMMDD + "0001" (12 digit, lolos firestore.rules monitortn; "0000" dipakai monitortn
// sehingga catatan tanggal lapor kedua monitor tidak saling menimpa).
import { H, DAY, wibDay, f2, pct } from './lib.mjs';
import { perf, funnel } from './metrics.mjs';

export const ID_SUFFIX = '0001';
export const logId = d => d.replace(/-/g, '') + ID_SUFFIX;
const addDays = (d, k) => new Date(Date.parse(d) + k * DAY).toISOString().slice(0, 10);

// Laporan rekonstruksi tanggal d dari jurnal (data sampai akhir hari d WIB).
// ALLT: {idMesin: [trade seragam]}; ev: config.engineEval
export function recon(d, ALLT, C, updated) {
  const cut = Date.parse(d) + DAY - 7 * H - 1, ev = C.engineEval;
  let m = `# Laporan REKONSTRUKSI SCALPING tanggal ${d} (dibuat ${updated.slice(0, 10)}; BUKAN snapshot asli)\n\nDihitung ulang dari jurnal forward dengan hanya memakai data sampai akhir ${d} (WIB). Trade yang baru selesai setelah itu dianggap belum selesai; sinyal batal yang waktu batalnya tidak tercatat dianggap menunggu sampai batas kedaluwarsa ${ev.expiryH} jam. TIDAK mencakup kondisi pasar, peringatan, uji silang, dan harga pada hari itu.\n\n## Forward test (biaya ${C.costPct}% pulang-pergi)\n| Mesin | Sinyal | Selesai | Terisi% | Win | R/trade | PF | Total R |\n|---|---|---|---|---|---|---|---|\n`;
  for (const [id, all] of Object.entries(ALLT)) {
    const rows = all.filter(t => t.asof <= cut).map(t => {
      if (t.exit && t.exit > cut) return { ...t, status: t.fill && t.fill <= cut ? 'OPEN' : 'WAITING', outcome: '', r: null, exit: null };
      if (t.status === 'CANCELLED' && t.asof + ev.expiryH * H > cut) return { ...t, status: 'WAITING', reason: '' };
      return t;
    });
    const p = perf(rows), fl = funnel(rows);
    m += `| ${id} | ${fl.total} | ${p.n || 0} | ${pct(fl.fillRate)} | ${pct(p.winRate)} | ${f2(p.avg)} | ${f2(p.pf)} | ${f2(p.total, 1)} |\n`;
  }
  return m + `\n## Permintaan\nEvaluasi laporan rekonstruksi ini seperti laporan biasa, dengan catatan bahwa ia dihitung ulang dari jurnal, bukan snapshot asli. Forward test = bukti; jujur soal sampel kecil.\n`;
}

// LG: riwayat dari laporan-log.json sebelumnya. Mengembalikan {LG (disimpan penuh), log (untuk data.json), hariId}
export function buildLog(LG, { hari, updated, md, recon: rc }) {
  LG = LG.map(x => (x.d ? x : { ...x, d: wibDay(Date.parse(x.t)) }));
  for (const k of [3, 2, 1]) {
    const d = addDays(hari, -k);
    if (!LG.some(x => x.d === d)) LG.push({ id: logId(d), d, t: updated, md: rc(d), rekon: true });
  }
  let cur = LG.find(x => x.d === hari);
  if (cur) { cur.t = updated; cur.md = md; } else { cur = { id: logId(hari), d: hari, t: updated, md }; LG.push(cur); }
  const batas = addDays(hari, -4);
  LG = LG.filter(x => x.d >= batas).sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
  return { LG, hariId: cur.id, log: LG.map(x => (x.d === hari ? { ...x, md: '' } : x)) };
}
