// Trains the draft win-rate predictor from league results where both sides battle identically.
// Usage: npx tsx scripts/train-oracle.ts [--bots randdraft,randdraft2] [--l2 0.01]
import * as fs from 'fs';
import * as path from 'path';
import { loadLibrary, loadPlatformLibrary, buildBssLibrary } from '../src/cards';
import { matchupVector, FEATURE_NAMES } from '../src/lib/features';
import type { Card } from '../src/types';
import type { OracleModel } from '../src/lib/oracle';

const args = process.argv.slice(2);
const arg = (k: string, d: string) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const allowed = new Set(arg('bots', 'randdraft,randdraft2').split(','));
const l2 = Number(arg('l2', '0.01'));

const lib = new Map<string, Card>();
for (const c of loadLibrary()) lib.set(c.id, c);
for (const c of loadPlatformLibrary()) lib.set(c.id, c);
try { for (const c of buildBssLibrary()) lib.set(c.id, c); } catch {}

const runsDir = path.join(__dirname, '..', 'data', 'runs');
const rows: { A: Card[]; B: Card[]; y: number }[] = [];
for (const run of fs.readdirSync(runsDir)) {
  const f = path.join(runsDir, run, 'results.jsonl');
  if (!fs.existsSync(f)) continue;
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!line) continue;
    const r = JSON.parse(line);
    if (r.error || r.winner === 'tie' || !allowed.has(r.sides.A) || !allowed.has(r.sides.B)) continue;
    if (r.picks.A.some((id: string) => !lib.has(id)) || r.picks.B.some((id: string) => !lib.has(id))) continue;
    rows.push({ A: r.picks.A.map((id: string) => lib.get(id)!), B: r.picks.B.map((id: string) => lib.get(id)!), y: r.winner === r.sides.A ? 1 : 0 });
  }
}
console.log(`${rows.length} decisive matches`);
let t = Date.now();
const X = rows.map(r => matchupVector(r.A, r.B));
const Y = rows.map(r => r.y);
console.log(`features in ${Date.now() - t} ms`);

// Deterministic shuffle, 80/20 split.
const order = X.map((_, i) => i).sort((a, b) => ((a * 2654435761) % 1000003) - ((b * 2654435761) % 1000003));
const cut = Math.floor(order.length * 0.8);
const tr = order.slice(0, cut), te = order.slice(cut);
const d = FEATURE_NAMES.length;
const scale = FEATURE_NAMES.map((_, j) => Math.sqrt(tr.reduce((s, i) => s + X[i][j] ** 2, 0) / tr.length) || 1);

function fit(cols: number[]): number[] {
  const w = new Array(d).fill(0);
  const lr = 0.5;
  for (let it = 0; it < 3000; it++) {
    const g = new Array(d).fill(0);
    for (const i of tr) {
      let z = 0; for (const j of cols) z += w[j] * X[i][j] / scale[j];
      const p = 1 / (1 + Math.exp(-z));
      for (const j of cols) g[j] += (p - Y[i]) * X[i][j] / scale[j];
    }
    for (const j of cols) w[j] -= lr * (g[j] / tr.length + l2 * w[j]);
  }
  return w;
}
function evaluate(w: number[], idx: number[]) {
  let correct = 0, ll = 0;
  for (const i of idx) {
    let z = 0; for (let j = 0; j < d; j++) z += w[j] * X[i][j] / scale[j];
    const p = Math.min(1 - 1e-6, Math.max(1e-6, 1 / (1 + Math.exp(-z))));
    if ((p > 0.5 ? 1 : 0) === Y[i]) correct++;
    ll += -(Y[i] * Math.log(p) + (1 - Y[i]) * Math.log(1 - p));
  }
  return { acc: correct / idx.length, ll: ll / idx.length };
}

t = Date.now();
const all = FEATURE_NAMES.map((_, j) => j);
const w = fit(all);
const ev = evaluate(w, te);
const base = evaluate(fit([FEATURE_NAMES.indexOf('win_mean')]), te);
console.log(`trained in ${Date.now() - t} ms`);
console.log(`holdout (${te.length}): acc ${(100 * ev.acc).toFixed(1)}%  logloss ${ev.ll.toFixed(4)}   | win_mean only: acc ${(100 * base.acc).toFixed(1)}%  logloss ${base.ll.toFixed(4)}   | coin flip logloss 0.6931`);

// Calibration on holdout.
const bins = [0, 0, 0, 0, 0].map(() => ({ n: 0, wins: 0, p: 0 }));
for (const i of te) {
  let z = 0; for (let j = 0; j < d; j++) z += w[j] * X[i][j] / scale[j];
  const p = 1 / (1 + Math.exp(-z));
  const b = bins[Math.min(4, Math.floor(p * 5))]; b.n++; b.wins += Y[i]; b.p += p;
}
console.log('calibration (predicted -> actual):', bins.filter(b => b.n).map(b => `${(100 * b.p / b.n).toFixed(0)}%->${(100 * b.wins / b.n).toFixed(0)}% (n=${b.n})`).join('  '));
console.log('weights (per 1 std of the feature difference, sorted):');
console.table(FEATURE_NAMES.map((n, j) => ({ feature: n, weight: +w[j].toFixed(3) })).sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight)));

const model: OracleModel = { names: FEATURE_NAMES, w, scale, trainedOn: tr.length, holdoutAcc: ev.acc, holdoutLogLoss: ev.ll };
fs.writeFileSync(path.join(__dirname, '..', 'data', 'oracle.json'), JSON.stringify(model, null, 1));
console.log('saved data/oracle.json');
