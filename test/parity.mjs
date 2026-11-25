// Dipanggil oleh test/parity.py: baca skenario dari stdin, jalankan simulate(), tulis hasil ke stdout.
import fs from 'node:fs';
import { simulate } from '../scripts/sim.mjs';
const cases = JSON.parse(fs.readFileSync(0, 'utf8'));
const ev = { fee: 0.10, expiryH: 24, holdH: 72 };
console.log(JSON.stringify(cases.map(c => { const r = simulate(c.s, c.cs, ev); return { status: r.status, outcome: r.outcome, r: r.r }; })));
