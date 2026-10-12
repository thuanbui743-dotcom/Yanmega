// Snake draft with Item Clause and a per-pick time limit (random legal pick on timeout or bad answer).
import type { Bot, Card, DraftView, Side } from './types';
import { Rng } from './rng';

export const SNAKE: Side[] = ['A', 'B', 'B', 'A', 'A', 'B', 'B', 'A', 'A', 'B', 'B', 'A'];

export function legalFor(team: Card[], available: Card[]): Card[] {
  const items = new Set(team.map(c => c.item));
  const legal = available.filter(c => !items.has(c.item));
  return legal.length ? legal : available; // clause deadlock fallback (rare)
}

export interface DraftResult {
  picks: Record<Side, Card[]>;
  log: { side: Side; card: string; timedOut: boolean; ms: number }[];
}

export async function withTimeout<T>(p: T | Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve(p),
      new Promise<undefined>(res => { timer = setTimeout(() => res(undefined), ms); }),
    ]);
  } catch {
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runDraft(pool: Card[], bots: Record<Side, Bot>, rng: Rng, pickMs = 15000): Promise<DraftResult> {
  const picks: Record<Side, Card[]> = { A: [], B: [] };
  const log: DraftResult['log'] = [];
  let available = [...pool];
  for (let i = 0; i < SNAKE.length; i++) {
    const side = SNAKE[i];
    const opp: Side = side === 'A' ? 'B' : 'A';
    const legal = legalFor(picks[side], available);
    const view: DraftView = {
      me: side, pool, order: SNAKE, pickIndex: i,
      picks: { A: [...picks.A], B: [...picks.B] },
      available: [...available], legal, oppLegal: legalFor(picks[opp], available),
    };
    const t0 = Date.now();
    let id: string | undefined;
    try { id = await withTimeout((async () => bots[side].draftPick(view))(), pickMs); } catch { id = undefined; }
    let card = legal.find(c => c.id === id);
    const timedOut = !card;
    if (!card) card = rng.pick(legal);
    picks[side].push(card);
    available = available.filter(c => c !== card);
    log.push({ side, card: card.id, timedOut, ms: Date.now() - t0 });
  }
  return { picks, log };
}
