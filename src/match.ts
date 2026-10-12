// One full match: random pool, snake draft, Team Preview, battle.
import type { Bot, Card, Side } from './types';
import { drawPool } from './cards';
import { runDraft } from './draft';
import { runBattle, BattleResult } from './battle';
import { Rng } from './rng';

export interface MatchResult {
  seed: number;
  first: string;                 // bot name that drafted first (side A)
  sides: Record<Side, string>;   // bot names
  pool: string[];
  picks: Record<Side, string[]>;
  winner: string | 'tie';        // bot name
  battle: Omit<BattleResult, 'log'>;
  draftTimeouts: number;
  log?: string[];
}

/** sideA drafts first and plays as p1. */
export async function playMatch(seed: number, sideA: Bot, sideB: Bot, opts: { keepLog?: boolean; pickMs?: number; decisionMs?: number } = {}): Promise<MatchResult> {
  const rng = new Rng(seed);
  const pool = drawPool(rng);
  const draft = await runDraft(pool, { A: sideA, B: sideB }, rng, opts.pickMs ?? 15000);
  const teams: { p1: Card[]; p2: Card[] } = { p1: draft.picks.A, p2: draft.picks.B };
  const battle = await runBattle(teams, { p1: sideA, p2: sideB }, { keepLog: opts.keepLog, seed: rng.int(2 ** 31), decisionMs: opts.decisionMs });
  const { log, ...rest } = battle;
  return {
    seed, first: sideA.name, sides: { A: sideA.name, B: sideB.name },
    pool: pool.map(c => c.id),
    picks: { A: draft.picks.A.map(c => c.id), B: draft.picks.B.map(c => c.id) },
    winner: battle.winner === 'tie' ? 'tie' : battle.winner === 'p1' ? sideA.name : sideB.name,
    battle: rest,
    draftTimeouts: draft.log.filter(l => l.timedOut).length,
    log,
  };
}
