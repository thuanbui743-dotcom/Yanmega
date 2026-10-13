// Draft: evaluate each legal candidate by rolling out the rest of the snake draft and scoring the final
// teams with the Team Preview game (both sides choose a bring by brute force over the simulator).
import type { Card, DraftView, Side } from '../../../src/types';
import { buildModel, simulate, Model } from './model';
import { winProb } from '../../../src/lib/oracle';
import { exploit, stackPenalty, attackWeights } from './weak';
const XC = process.env.DR_XC !== undefined ? Number(process.env.DR_XC) : 0;
const WS = process.env.DR_WS !== undefined ? Number(process.env.DR_WS) : 0;
const ORC = process.env.DR_ORC !== undefined ? Number(process.env.DR_ORC) : 0.5;

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
  const L = env('DR_L', 2), beta = env('DR_BETA', 5);

  // Prune candidates to the top-K by power to bound time.
  const K = env('DR_K', 10);
  const cands = [...legal].sort((a, b) => pw[b] - pw[a]).slice(0, K);
  const M = env('DR_ADV_M', 3), lam = env('DR_ADV_LAM', 0.5);
  const rollout = (teams0: Record<Side, number[]>, pool0: number[], from: number): number => {
    const teams: Record<Side, number[]> = { A: [...teams0.A], B: [...teams0.B] };
    let pool = pool0;
    for (let p = from; p < v.order.length; p++) {
      const s = v.order[p];
      const lg = legalFor(teams[s], pool, m);
      let pick = lg[0];
      if (s === opp && XC > 0) {
        const T = teams[me].map(i => m.cards[i]);
        let bs = -Infinity;
        for (const x of lg) { const sc = pw[x] + XC * exploit(m.cards[x], T); if (sc > bs) { bs = sc; pick = x; } }
      } else for (const x of lg) if (pw[x] > pw[pick]) pick = x;
      teams[s].push(pick);
      pool = pool.filter(x => x !== pick);
    }
    let tv = teamValue(m, teams[me], teams[opp], pw, L, beta);
    if (WS > 0) {
      const Tm = teams[me].map(i => m.cards[i]), To = teams[opp].map(i => m.cards[i]);
      tv -= WS * (stackPenalty(Tm, attackWeights(To)) - stackPenalty(To, attackWeights(Tm)));
    }
    if (ORC > 0) { const p = winProb(teams[me].map(i => m.cards[i]), teams[opp].map(i => m.cards[i])); if (p > 0 && p < 1 && p !== 0.5) tv += ORC * Math.log(p / (1 - p)); }
    return tv;
  };
  const t0 = Date.now(), budget = env("DR_BUDGET_MS", 1500);
  let best = cands[0], bv = -Infinity;
  for (const c of cands) {
    if (Date.now() - t0 > budget) break; // time guard: keep the best so far (candidates are power-sorted)
    const teams = { [me]: [...myT, c], [opp]: [...opT] } as Record<Side, number[]>;
    const pool = avail.filter(x => x !== c);
    let val = rollout(teams, pool, v.pickIndex + 1);
    if (M > 0 && v.pickIndex + 1 < v.order.length && v.order[v.pickIndex + 1] === opp) {
      // Adversarial opponent reply: try its top-M legal picks for each of its consecutive picks.
      const nOpp = v.pickIndex + 2 < v.order.length && v.order[v.pickIndex + 2] === opp ? 2 : 1;
      let worst = Infinity;
      const lg1 = legalFor(teams[opp], pool, m).sort((a, b) => pw[b] - pw[a]).slice(0, M);
      for (const x of lg1) {
        const t1 = { [me]: teams[me], [opp]: [...teams[opp], x] } as Record<Side, number[]>;
        const p1 = pool.filter(y => y !== x);
        if (nOpp === 2) {
          const lg2 = legalFor(t1[opp], p1, m).sort((a, b) => pw[b] - pw[a]).slice(0, M);
          for (const y of lg2) {
            const t2 = { [me]: t1[me], [opp]: [...t1[opp], y] } as Record<Side, number[]>;
            worst = Math.min(worst, rollout(t2, p1.filter(z => z !== y), v.pickIndex + 3));
          }
        } else worst = Math.min(worst, rollout(t1, p1, v.pickIndex + 2));
      }
      if (worst < Infinity) val = (1 - lam) * val + lam * worst;
    }
    if (val > bv) { bv = val; best = c; }
  }
  return m.cards[best].id;
}
