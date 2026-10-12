// Draft: evaluate each legal candidate by rolling out the rest of the snake draft and scoring the final
// teams with the Team Preview game (both sides choose a bring by brute force over the simulator).
import type { Card, DraftView, Side } from '../../../src/types';
import { buildModel, simulate, Model } from './model';

const env = (k: string, d: number) => (process.env[k] !== undefined ? Number(process.env[k]) : d);

/** Per-card power: mean sim margin of the card's best pair... kept simple: mean best damage dealt minus taken + speed. */
export function powers(m: Model): number[] {
  const n = m.n;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) if (j !== i) s += oneVsOneM(m, i, j);
    out.push(s / (n - 1));
  }
  return out;
}

export function oneVsOneM(m: Model, a: number, b: number): number {
  const da = m.best[a][b], db = m.best[b][a];
  const ha = da > 0 ? Math.ceil(100 / da) : 99, hb = db > 0 ? Math.ceil(100 / db) : 99;
  if (ha !== hb) return ha < hb ? 1 : 0;
  if (ha === 99) return 0.5;
  const sa = m.info[a].spe, sb = m.info[b].spe;
  return sa === sb ? 0.5 : sa > sb ? 1 : 0;
}

/** Bring options for a team: all 4-subsets, each with L lead pairs ranked by lead heuristic. */
export function options(m: Model, team: number[], pw: number[], L: number): number[][] {
  const n = team.length;
  const subs: number[][] = [];
  if (n <= 4) subs.push([...team]);
  else {
    const rec = (start: number, cur: number[]) => {
      if (cur.length === 4) { subs.push(cur); return; }
      for (let k = start; k < n; k++) rec(k + 1, [...cur, team[k]]);
    };
    rec(0, []);
  }
  const out: number[][] = [];
  for (const s0 of subs) {
    const s = [...s0].sort((a, b) => pw[b] - pw[a]);
    const k = s.length;
    const pairs: number[][] = [];
    for (let x = 0; x < k; x++) for (let y = x + 1; y < k; y++) {
      pairs.push([s[x], s[y], ...s.filter((_, z) => z !== x && z !== y)]);
    }
    if (!pairs.length) pairs.push(s);
    for (let q = 0; q < Math.min(L, pairs.length); q++) out.push(pairs[q]);
  }
  return out;
}

/** Soft team-preview value of matrix P for the row player. */
export function softValue(P: number[][], beta: number): number {
  const R = P.length, C = P[0].length;
  const cm = new Array(C).fill(0);
  for (let j = 0; j < C; j++) { for (let i = 0; i < R; i++) cm[j] += P[i][j]; cm[j] /= R; }
  const lo = Math.min(...cm);
  const w = cm.map(x => Math.exp(-beta * (x - lo)));
  const ws = w.reduce((a, b) => a + b, 0);
  let best = -Infinity;
  for (let i = 0; i < R; i++) { let s = 0; for (let j = 0; j < C; j++) s += w[j] * P[i][j]; if (s > best) best = s; }
  return best / ws;
}

export function teamValue(m: Model, mine: number[], theirs: number[], pw: number[], L: number, beta: number): number {
  const A = options(m, mine, pw, L), B = options(m, theirs, pw, L);
  const P = A.map(a => B.map(b => simulate(m, a, b)));
  return softValue(P, beta);
}

function legalFor(team: number[], avail: number[], m: Model): number[] {
  const items = new Set(team.map(i => m.cards[i].item));
  const l = avail.filter(i => !items.has(m.cards[i].item));
  return l.length ? l : avail;
}

export function chooseDraft(v: DraftView): string {
  const m = buildModel(v.pool);
  const pw = powers(m);
  const me = v.me, opp: Side = me === 'A' ? 'B' : 'A';
  const myT = v.picks[me].map(c => m.idx.get(c.id)!);
  const opT = v.picks[opp].map(c => m.idx.get(c.id)!);
  const avail = v.available.map(c => m.idx.get(c.id)!);
  const legal = v.legal.map(c => m.idx.get(c.id)!);
  const L = env('DR_L', 1), beta = env('DR_BETA', 5);

  // Prune candidates to the top-K by power to bound time.
  const K = env('DR_K', 10);
  const cands = [...legal].sort((a, b) => pw[b] - pw[a]).slice(0, K);
  let best = cands[0], bv = -Infinity;
  for (const c of cands) {
    // Rollout: remaining picks follow power-greedy with Item Clause.
    const teams: Record<Side, number[]> = { [me]: [...myT, c], [opp]: [...opT] } as any;
    let pool = avail.filter(x => x !== c);
    for (let p = v.pickIndex + 1; p < v.order.length; p++) {
      const s = v.order[p];
      const lg = legalFor(teams[s], pool, m);
      let pick = lg[0];
      for (const x of lg) if (pw[x] > pw[pick]) pick = x;
      teams[s].push(pick);
      pool = pool.filter(x => x !== pick);
    }
    const val = teamValue(m, teams[me], teams[opp], pw, L, beta);
    if (val > bv) { bv = val; best = c; }
  }
  return m.cards[best].id;
}
