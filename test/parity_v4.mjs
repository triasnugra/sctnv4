// Dipanggil oleh test/parity_v4.py: baca skenario dari stdin, jalankan simulatePy(), tulis hasil ke stdout.
import fs from 'node:fs';
import { simulatePy } from '../scripts/sim.mjs';
const cases = JSON.parse(fs.readFileSync(0, 'utf8'));
console.log(JSON.stringify(cases.map(c => { const r = simulatePy(c.s, c.cs, c.ev); return { status: r.status, outcome: r.outcome, r: r.r }; })));
