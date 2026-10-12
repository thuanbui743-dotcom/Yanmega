// Oracle drafter: for each legal card, roll out the rest of the snake draft many times with a fast
// policy for both sides, score final rosters with the win-rate predictor, pick the best average.
// Team Preview picks the bring-4 the predictor likes most vs the opponent's 6. Battles like greedy.
import type { Bot, Card, DraftView, Side } from '../types';
import { greedyBot } from './greedy';
import { analyzePool, PoolAnalysis } from '../lib/pool';
import { winProb, loadOracle } from '../lib/oracle';
import { legalFor } from '../draft';
import { Rng } from '../rng';

export interface OracleOpts { rollouts?: number; timeMs?: number }

export const oracleBot = (opts: OracleOpts = {}): Bot => {
  const rollouts = opts.rollouts ?? 24;
  const timeMs = opts.timeMs ?? 4000;
  const g = greedyBot();
  let pa: PoolAnalysis | null = null;

  // Rollout policy: mostly the highest pool-power legal card, sometimes the 2nd/3rd.
  const policy = (legal: Card[], rng: Rng): Card => {
    const p = pa!;
    const ranked = [...legal].sort((a, b) => p.power[p.idx.get(b.id)!] - p.power[p.idx.get(a.id)!]);
    const r = rng.next();
    return ranked[r < 0.6 ? 0 : r < 0.85 ? Math.min(1, ranked.length - 1) : Math.min(2, ranked.length - 1)];
  };

  const rollout = (v: DraftView, first: Card, rng: Rng): number => {
    const me = v.me, opp: Side = me === 'A' ? 'B' : 'A';
    const picks: Record<Side, Card[]> = { A: [...v.picks.A], B: [...v.picks.B] };
    picks[me].push(first);
    let avail = v.available.filter(c => c !== first);
    for (let i = v.pickIndex + 1; i < v.order.length; i++) {
      const s = v.order[i];
      const c = policy(legalFor(picks[s], avail), rng);
      picks[s].push(c);
      avail = avail.filter(x => x !== c);
    }
    return winProb(picks[me], picks[opp]);
  };

  return {
    ...g,
    name: 'oracle',
    draftPick: v => {
      if (!pa || pa.cards !== v.pool) pa = analyzePool(v.pool);
      if (!loadOracle() || v.legal.length === 1) return g.draftPick(v) as string;
      const t0 = Date.now();
      const score = new Map<string, number>(v.legal.map(c => [c.id, 0]));
      let done = 0;
      // Common random numbers: rollout k uses the same seed for every candidate.
      for (let k = 0; k < rollouts; k++) {
        for (const c of v.legal) score.set(c.id, score.get(c.id)! + rollout(v, c, new Rng(1000 + k)));
        done++;
        if (Date.now() - t0 > timeMs) break;
      }
      let best = v.legal[0];
      for (const c of v.legal) if (score.get(c.id)! > score.get(best.id)!) best = c;
      return best.id;
    },
    teamPreview: v => {
      if (!loadOracle()) return g.teamPreview(v);
      let best: number[] = [0, 1, 2, 3], bestP = -1;
      for (let a = 0; a < 6; a++) for (let b = a + 1; b < 6; b++) for (let c = b + 1; c < 6; c++) for (let d = c + 1; d < 6; d++) {
        const p = winProb([a, b, c, d].map(i => v.myTeam[i]), v.oppTeam);
        if (p > bestP) { bestP = p; best = [a, b, c, d]; }
      }
      // Leads: reuse greedy's ordering restricted to the chosen four.
      const gp = (g.teamPreview(v) as { order: number[] }).order;
      const rank = (i: number) => { const r = gp.indexOf(i); return r < 0 ? 9 : r; };
      return { order: best.sort((x, y) => rank(x) - rank(y)) };
    },
  };
};
