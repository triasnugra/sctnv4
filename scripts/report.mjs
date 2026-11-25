// Laporan Markdown "untuk Claude": ringkasan seluruh evaluasi, disalin dari situs ke chat.
import { f2, pct } from './lib.mjs';

const row = (...c) => '| ' + c.join(' | ') + ' |\n';
const ci = x => (x ? `${f2(x[0])}..${f2(x[1])}` : '-');
function bd(title, arr, n = 8) {
  if (!arr?.length) return '';
  return `- ${title}: ` + arr.slice(0, n).map(x => `${x.k} n=${x.n} R/trade ${f2(x.avg)} win ${pct(x.win)}`).join(' | ') + '\n';
}

export function buildReport(out, C) {
  let m = `# Laporan monitor SCALPING untuk Claude (${out.updated})\n\nBiaya acuan ${C.costPct}% pulang-pergi (mesin sctn* mengasumsikan ${C.engineFeePct}%, sctnv4 ${C.engines.find(x => x.fmt === 'history')?.engineFeePct ?? '-'}%). Win = R>0. CI95 = bootstrap per hari.\n\n`;
  m += `## Forward test (bukti utama)\n` + row('Mesin', 'Sinyal', 'Selesai', 'Terisi%', 'Win (CI)', 'R/trade', 'CI95 R', 'PF', 'SQN', 'Total R', 'MaxDD R', 'Median tahan (jam)', 'Verdict') + row(...Array(13).fill('---'));
  for (const e of out.engines) { const f = e.fwd; m += row(e.id, e.funnel.total, f.n, pct(e.funnel.fillRate), `${pct(f.winRate)} ${f.winCI ? `(${pct(f.winCI[0])}-${pct(f.winCI[1])})` : ''}`, f2(f.avg), ci(f.ci), f2(f.pf), f2(f.sqn), f2(f.total, 1), f2(f.maxDD, 1), f2(f.hold?.med, 1), e.verdict); }
  m += `\n## Gerbang kelayakan (forward)\n`;
  for (const e of out.engines) m += `- ${e.id}: ` + e.gates.list.map(x => `${x[0] ? 'OK' : 'GAGAL'} ${x[1]}`).join('; ') + '\n';
  m += `\n## Corong sinyal\n`;
  for (const e of out.engines) { const f = e.funnel; m += `- ${e.id}: ${f.total} sinyal -> selesai ${f.CLOSED}, berjalan ${f.OPEN}, menunggu ${f.WAITING}, batal ${f.CANCELLED} (${Object.entries(f.why).map(([k, v]) => `${k}: ${v}`).join('; ') || '-'}). Per jenis: ${f.bySig.map(x => `${x.k} terisi ${x.terisi}/${x.terisi + x.batal}`).join(', ')}\n`; }
  m += `\n## Backtest (hipotesis, BUKAN bukti)\n` + row('Mesin', 'Periode', 'Selesai', 'Terisi%', 'Win', 'R/trade', 'CI95 R', 'PF', 'Total R', 'MaxDD R', 'Level unik', 'Tanpa 2 koin teratas (R/trade, total)') + row(...Array(12).fill('---'));
  for (const e of out.engines) { const b = e.bt; if (!b) { m += row(e.id, 'tidak ada', ...Array(10).fill('-')); continue; } m += row(e.id, (b.meta.period || []).map(x => x.slice(5, 10)).join('→'), b.n, pct(b.funnel.fillRate), pct(b.winRate), f2(b.avg), ci(b.ci), f2(b.pf), f2(b.total, 1), f2(b.maxDD, 1), b.level ? `${b.level.u} (N efektif ${f2(b.level.neff, 0)})` : '-', b.lo ? `${f2(b.lo.restAvg)}, ${f2(b.lo.restTotal, 1)}R tanpa ${b.lo.top.join('+')}` : '-'); }
  if (out.btWindow) { m += `\n### Jendela & koin bersama (${out.btWindow.from.slice(0, 10)} → ${out.btWindow.to.slice(0, 10)}, ${C.commonSymbols.length} koin)\n`; for (const e of out.engines) if (e.btCommon) m += `- ${e.id}: n=${e.btCommon.n}, R/trade ${f2(e.btCommon.avg)}, PF ${f2(e.btCommon.pf)}, total ${f2(e.btCommon.total, 1)}R, CI95 ${ci(e.btCommon.ci)}\n`; }
  m += `\n## Pecahan (backtest, kecuali disebut forward)\n`;
  for (const e of out.engines) { if (!e.bt) continue; m += `### ${e.id}\n` + bd('arah', e.bt.dir) + bd('trigger / TF', e.bt.trig) + bd('koin', e.bt.sym, 10) + bd('sesi', e.bt.sesi) + bd('skor', e.bt.skor) + bd('lebar stop', e.bt.stop) + bd('rezim volatilitas BTC', e.bt.rezim) + bd('arah BTC', e.bt.rezimArah); }
  m += `\n## Forward per dimensi\n`;
  for (const e of out.engines) { if (!e.fwd.n) continue; m += `### ${e.id}\n` + bd('arah', e.dir) + bd('trigger / TF', e.trig) + bd('koin', e.sym) + bd('sesi', e.sesi); }
  m += `\n## Biaya (R/trade pada biaya 0 / ${C.costPct} / 0,3%) & biaya impas\n`;
  for (const e of out.engines) { const c = e.bt?.cost; if (c) m += `- ${e.id} backtest: biaya impas ${f2(c.be, 3)}%; R/trade pada biaya ${c.curve.map(x => x.c + '%: ' + f2(x.r)).join(', ')}; beban biaya median ${f2(C.costPct * c.feeR)}R per trade pada ${C.costPct}%\n`; }
  m += `\n## Uji silang candle 1 menit (forward)\n`;
  for (const e of out.engines) { m += e.audit ? `- ${e.id}: ${e.audit.n} trade dihitung ulang, ${e.audit.sama} sama, ${e.audit.beda} beda (selisih R rata-rata ${f2(e.audit.dRrata)})\n` : `- ${e.id}: tidak dijalankan\n`; const q = e.audit?.fill; if (q) m += `  - sadar-pengisian (candle 1m): ${q.n} trade selesai = ${q.zone} entry-zone + ${q.limit} limit; ${q.batal} tidak pernah terisi; R total mesin ${f2(q.rEng, 1)} vs sadar-pengisian ${f2(q.rAware, 1)} (n=${q.nAware})\n`; }
  if (out.regime) m += `\n## Kondisi pasar\n- ${out.regime.status}${out.regime.flags.length ? ' (' + out.regime.flags.join('; ') + ')' : ''}; BTC ${f2(out.regime.btc, 0)}, arah 1H ${out.regime.arah}, rentang 24 jam ${f2(out.regime.range24, 2)}% per candle, sesi ${out.regime.sesi}\n`;
  m += `\n## Sinyal menunggu / berjalan\n` + (out.pending.map(p => `- ${p.e} ${p.s} ${p.d} ${p.sg} entry ${p.en} harga ${p.px ?? '-'}: ${p.ket}`).join('\n') || '- tidak ada') + '\n';
  m += `\n## Warning\n` + out.warnings.map(w => `- [${w.lvl}] ${w.e}: ${w.t}${w.aksi ? ' -> ' + w.aksi : ''}`).join('\n') + '\n';
  m += `\n## Permintaan\nEvaluasi laporan ini. Jujur soal sampel kecil, korelasi antar koin, dan rezim pasar. Jangan ubah logika sinyal mesin selama forward test berjalan tanpa memulai protokol baru (config_hash baru). Jika perlu perbaikan, buatkan full coding (zip utuh siap upload ke GitHub web UI) dan sebutkan apa yang diuji ulang.\n`;
  return m;
}
