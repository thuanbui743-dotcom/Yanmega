// Team Preview by brute force: every bring order for both sides through the simulator, solved as a zero-sum game.
import type { Card, PreviewChoice } from '../../../src/types';
import { oneVsOne } from '../../../src/lib/pool';
import { buildModel, bringOrders, simulate, Model } from './model';
import { attackWeights, bringPenalty } from './weak';

/** Approximate Nash equilibrium of a zero-sum payoff matrix (row player maximizes) via fictitious play. */
export function solveGame(P: number[][], iters = 300): { row: number[]; col: number[]; value: number } {
  const R = P.length, C = P[0].length;
  const rowCount = new Array(R).fill(0), colCount = new Array(C).fill(0);
  const rowPay = new Array(R).fill(0); // cumulative payoff of each row vs col history
  const colPay = new Array(C).fill(0); // cumulative payoff (to row) of each col vs row history
  let r = 0, c = 0;
  // start from maximin row
  let best = -Infinity;
  for (let i = 0; i < R; i++) { const mn = Math.min(...P[i]); if (mn > best) { best = mn; r = i; } }
  for (let t = 0; t < iters; t++) {
    rowCount[r]++;
    for (let j = 0; j < C; j++) colPay[j] += P[r][j];
    c = 0; for (let j = 1; j < C; j++) if (colPay[j] < colPay[c]) c = j;
    colCount[c]++;
    for (let i = 0; i < R; i++) rowPay[i] += P[i][c];
    r = 0; for (let i = 1; i < R; i++) if (rowPay[i] > rowPay[r]) r = i;
  }
  const row = rowCount.map(x => x / iters), col = colCount.map(x => x / iters);
  let value = 0;
  for (let i = 0; i < R; i++) if (row[i]) for (let j = 0; j < C; j++) if (col[j]) value += row[i] * col[j] * P[i][j];
  return { row, col, value };
}

export function payoff(m: Model, mine: number[][], theirs: number[][]): number[][] {
  return mine.map(a => theirs.map(b => simulate(m, a, b)));
}

export function choosePreview(myTeam: Card[], oppTeam: Card[]): PreviewChoice {
  const m = buildModel([...myTeam, ...oppTeam]);
  const me = myTeam.map((_, i) => i), opp = oppTeam.map((_, i) => i + myTeam.length);
  let mine = bringOrders(me);
  const theirs = bringOrders(opp);
  if (!process.env.PV_NOBENCH) mine = mine.flatMap(o => o.length === 4 ? [o, [o[0], o[1], o[3], o[2]]] : [o]);
  const WB = process.env.PV_WB !== undefined ? Number(process.env.PV_WB) : 0.06;
  const aOpp = attackWeights(oppTeam), aMe = attackWeights(myTeam);
  const pA = mine.map(o => WB * bringPenalty(o.slice(0, 4).map(i => m.cards[i]), aOpp));
  const pB = theirs.map(o => WB * bringPenalty(o.slice(0, 4).map(i => m.cards[i]), aMe));
  const P = payoff(m, mine, theirs).map((row, i) => row.map((x, j) => x - pA[i] + pB[j]));

  const mode = process.env.PV_MODE || "soft";
  if (mode === "maximin") { let bi2 = 0, bv2 = -Infinity; for (let i = 0; i < mine.length; i++) { const mn = Math.min(...P[i]); if (mn > bv2) { bv2 = mn; bi2 = i; } } return { order: mine[bi2] }; }
  if (mode === "exploit") {
    const sc = (c: Card) => myTeam.reduce((s, o) => s + oneVsOne(c, o), 0);
    const ord = oppTeam.map((c, i) => ({ i, s: sc(c) })).sort((a, b) => b.s - a.s).map(x => x.i + myTeam.length).slice(0, 4);
    let bi2 = 0, bv2 = -Infinity; for (let i = 0; i < mine.length; i++) { const s = simulate(m, mine[i], ord); if (s > bv2) { bv2 = s; bi2 = i; } } return { order: mine[bi2] };
  }
  if (mode === "soft") {
    const beta = Number(process.env.PV_BETA || "5");
    const C = theirs.length;
    const cm = new Array(C).fill(0);
    for (let j = 0; j < C; j++) { for (let i = 0; i < mine.length; i++) cm[j] += P[i][j]; cm[j] /= mine.length; }
    const lo = Math.min(...cm);
    const w = cm.map(x => Math.exp(-beta * (x - lo)));
    let bi2 = 0, bv2 = -Infinity;
    for (let i = 0; i < mine.length; i++) { let s = 0; for (let j = 0; j < C; j++) s += w[j] * P[i][j]; if (s > bv2) { bv2 = s; bi2 = i; } }
    return { order: mine[bi2] };
  }
  if (mode === "mean") { let bi2 = 0, bv2 = -Infinity; for (let i = 0; i < mine.length; i++) { const s = P[i].reduce((a, b) => a + b, 0); if (s > bv2) { bv2 = s; bi2 = i; } } return { order: mine[bi2] }; }
  const g = solveGame(P);
  let bi = 0, bv = -Infinity;
  for (let i = 0; i < mine.length; i++) {
    let v = 0, mn = Infinity;
    for (let j = 0; j < theirs.length; j++) { if (g.col[j]) v += g.col[j] * P[i][j]; if (P[i][j] < mn) mn = P[i][j]; }
    const s = v + 0.1 * mn;
    if (s > bv) { bv = s; bi = i; }
  }
  return { order: mine[bi] };
}
