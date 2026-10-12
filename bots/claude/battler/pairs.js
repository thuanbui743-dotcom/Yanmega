// node pairs.js <runDir>: paired-seed outcome counts for claude/battler
const fs = require('fs');
const L = fs.readFileSync(process.argv[2] + '/results.jsonl', 'utf8').trim().split('\n').map(JSON.parse);
const me = process.argv[3] || 'claude/battler';
const by = {};
for (const r of L) (by[r.seed] ??= []).push(r.winner === me ? 1 : 0);
const c = { 0: 0, 1: 0, 2: 0 }; const lb = [];
for (const s in by) { const w = by[s].reduce((a, b) => a + b, 0); c[w]++; if (w === 0) lb.push(s); }
console.log(JSON.stringify(c), 'lost both:', lb.slice(0, 15).join(' '));
