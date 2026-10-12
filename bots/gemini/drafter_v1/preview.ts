// Gemini Team Preview: evaluates bring orders via fast simulator and solves zero-sum game.
import type { Card, PreviewChoice } from '../../../src/types';
import { oneVsOne } from '../../../src/lib/pool';
import { buildModel, bringOrders, simulate, Model } from './model';

export function solveGame(P: number[][], iters = 250): { row: number[]; col: number[]; value: number } {
  const R = P.length, C = P[0].length;
  const rowCount = new Array(R).fill(0), colCount = new Array(C).fill(0);
  const rowPay = new Array(R).fill(0);
  const colPay = new Array(C).fill(0);
  let r = 0, c = 0;
  let best = -Infinity;
  for (let i = 0; i < R; i++) {
    const mn = Math.min(...P[i]);
    if (mn > best) { best = mn; r = i; }
  }
  for (let t = 0; t < iters; t++) {
    rowCount[r]++;
    for (let j = 0; j < C; j++) colPay[j] += P[r][j];
    c = 0;
    for (let j = 1; j < C; j++) if (colPay[j] < colPay[c]) c = j;
    colCount[c]++;
    for (let i = 0; i < R; i++) rowPay[i] += P[i][c];
    r = 0;
    for (let i = 1; i < R; i++) if (rowPay[i] > rowPay[r]) r = i;
  }
  const row = rowCount.map(x => x / iters), col = colCount.map(x => x / iters);
  let value = 0;
  for (let i = 0; i < R; i++) if (row[i]) for (let j = 0; j < C; j++) if (col[j]) value += row[i] * col[j] * P[i][j];
  return { row, col, value };
}

export function choosePreview(myTeam: Card[], oppTeam: Card[]): PreviewChoice {
  const m = buildModel([...myTeam, ...oppTeam]);
  const me = myTeam.map((_, i) => i);
  const opp = oppTeam.map((_, i) => i + myTeam.length);

  const mine = bringOrders(me);
  const theirs = bringOrders(opp);

  // Predict greedy bring
  const scoreCard = (c: Card) => myTeam.reduce((s, o) => s + oneVsOne(c, o), 0);
  const greedyOppBring = oppTeam
    .map((c, i) => ({ i, s: scoreCard(c) }))
    .sort((a, b) => b.s - a.s)
    .map(x => x.i + myTeam.length)
    .slice(0, 4);

  // Find index of greedy bring in theirs (match leads and bench)
  const greedyIdx = theirs.findIndex(o =>
    o[0] === greedyOppBring[0] && o[1] === greedyOppBring[1] &&
    new Set(o).size === 4 && o.every(x => greedyOppBring.includes(x))
  );

  // Payoff matrix
  const P = mine.map(a => theirs.map(b => simulate(m, a, b)));

  // Soft minimax with greedy prior
  const beta = 5;
  const C = theirs.length;
  const cm = new Array(C).fill(0);
  for (let j = 0; j < C; j++) {
    for (let i = 0; i < mine.length; i++) cm[j] += P[i][j];
    cm[j] /= mine.length;
  }
  const lo = Math.min(...cm);
  const w = cm.map(x => Math.exp(-beta * (x - lo)));

  // Boost greedy bring probability
  if (greedyIdx >= 0) {
    w[greedyIdx] *= 3.0;
  }

  let bestIdx = 0, bestVal = -Infinity;
  for (let i = 0; i < mine.length; i++) {
    let s = 0;
    for (let j = 0; j < C; j++) s += w[j] * P[i][j];
    if (s > bestVal) { bestVal = s; bestIdx = i; }
  }

  return { order: mine[bestIdx] };
}
