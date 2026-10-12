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

  let mine = bringOrders(me);
  const theirs = bringOrders(opp);
  mine = mine.flatMap(o => o.length === 4 ? [o, [o[0], o[1], o[3], o[2]]] : [o]);

  // Payoff matrix
  const P = mine.map(a => theirs.map(b => simulate(m, a, b)));

  // Soft minimax over all opponent brings
  const beta = 5;
  const C = theirs.length;
  const cm = new Array(C).fill(0);
  for (let j = 0; j < C; j++) {
    for (let i = 0; i < mine.length; i++) cm[j] += P[i][j];
    cm[j] /= mine.length;
  }
  const lo = Math.min(...cm);
  const w = cm.map(x => Math.exp(-beta * (x - lo)));

  let bestIdx = 0, bestVal = -Infinity;
  for (let i = 0; i < mine.length; i++) {
    let s = 0;
    for (let j = 0; j < C; j++) s += w[j] * P[i][j];
    if (s > bestVal) { bestVal = s; bestIdx = i; }
  }

  return { order: mine[bestIdx] };
}
