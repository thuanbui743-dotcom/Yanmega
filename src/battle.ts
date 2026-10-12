// Runs one Team Preview + battle between two bots in the local Showdown simulator.
import { BattleStream, getPlayerStreams } from 'pokemon-showdown';
import type { Bot, Card, PreviewChoice } from './types';
import { toPackedTeam } from './cards';
import { Tracker } from './state';
import { withTimeout } from './draft';
import { Rng } from './rng';
import { slotOptions, jointChoices } from './lib/choices';

export const FORMAT = 'gen9doublescustomgame@@@Picked Team Size = 4,Terastal Clause,Species Clause,Endless Battle Clause';

export interface BattleResult {
  winner: 'p1' | 'p2' | 'tie';
  turns: number;
  brought: { p1: string[]; p2: string[] };
  invalid: { p1: number; p2: number };
  timeouts: { p1: number; p2: number };
  log?: string[];
}

export interface BattleOpts { decisionMs?: number; previewMs?: number; maxTurns?: number; keepLog?: boolean; seed?: number }

function randomPreview(rng: Rng): PreviewChoice {
  const idx = [0, 1, 2, 3, 4, 5];
  for (let i = 5; i > 0; i--) { const j = rng.int(i + 1); [idx[i], idx[j]] = [idx[j], idx[i]]; }
  return { order: idx.slice(0, 4) };
}

function validPreview(c: PreviewChoice | undefined): c is PreviewChoice {
  return !!c && Array.isArray(c.order) && c.order.length === 4 && new Set(c.order).size === 4
    && c.order.every(i => Number.isInteger(i) && i >= 0 && i < 6);
}

export async function runBattle(teams: { p1: Card[]; p2: Card[] }, bots: { p1: Bot; p2: Bot }, opts: BattleOpts = {}): Promise<BattleResult> {
  const { decisionMs = 50000, previewMs = 85000, maxTurns = 200, keepLog = false } = opts;
  const rng = new Rng(opts.seed ?? Math.floor(Math.random() * 2 ** 31));
  const stream = new BattleStream();
  const ps = getPlayerStreams(stream);
  const result: BattleResult = {
    winner: 'tie', turns: 0, brought: { p1: [], p2: [] },
    invalid: { p1: 0, p2: 0 }, timeouts: { p1: 0, p2: 0 },
  };
  const fullLog: string[] = [];
  let done = false;

  const play = async (side: 'p1' | 'p2') => {
    const me = teams[side], opp = teams[side === 'p1' ? 'p2' : 'p1'];
    const bot = bots[side];
    const tracker = new Tracker(side, me, opp);
    let pending: any = null;
    let decisionId = 0;

    const decide = async (req: any, id: number) => {
      if (id !== decisionId || done) return;
      let choice: string | undefined;
      if (req.teamPreview) {
        const c = await withTimeout((async () => bot.teamPreview({ me: side === 'p1' ? 'A' : 'B', myTeam: me, oppTeam: opp }))(), previewMs);
        const pc = validPreview(c) ? c : (result.timeouts[side]++, randomPreview(rng));
        result.brought[side] = pc.order.map(i => me[i].id);
        choice = `team ${pc.order.map(i => i + 1).join('')}`;
      } else {
        tracker.syncRequest(req);
        choice = await withTimeout((async () => bot.chooseAction({
          request: req, state: tracker.state, myTeam: me, oppTeam: opp, deadlineMs: decisionMs,
        }))(), decisionMs);
        if (!choice) { result.timeouts[side]++; choice = rng.pick(jointChoices(slotOptions(req))).choice; }
      }
      if (id === decisionId && !done) ps[side].write(choice);
    };

    for await (const chunk of ps[side] as any) {
      for (const line of (chunk as string).split('\n')) {
        if (line.startsWith('|request|')) {
          const raw = line.slice(9);
          if (!raw) continue;
          const req = JSON.parse(raw);
          if (req.wait) continue;
          pending = req;
          const id = ++decisionId;
          // Defer so the log lines for this turn (sent after the request) are ingested first.
          setTimeout(() => decide(pending, id), 0);
        } else if (line.startsWith('|error|')) {
          result.invalid[side]++;
          if (pending) {
            const id = ++decisionId;
            ps[side].write(result.invalid[side] > 50 ? 'forfeit' : 'default');
            void id;
          }
        } else {
          try { tracker.ingest(line); } catch { /* never let tracking crash a game */ }
        }
      }
      if (done) break;
    }
  };

  const watch = async () => {
    for await (const chunk of ps.omniscient as any) {
      for (const line of (chunk as string).split('\n')) {
        if (keepLog) fullLog.push(line);
        if (line.startsWith('|turn|')) {
          result.turns = Number(line.slice(6));
          if (result.turns > maxTurns) { done = true; ps.omniscient.write('>forcetie'); }
        } else if (line.startsWith('|win|')) {
          result.winner = line.slice(5) === 'p1' ? 'p1' : 'p2'; done = true;
        } else if (line === '|tie') {
          result.winner = 'tie'; done = true;
        }
      }
      if (done) break;
    }
  };

  const p1 = play('p1'), p2 = play('p2'), w = watch();
  ps.omniscient.write(`>start ${JSON.stringify({ formatid: FORMAT, seed: [rng.int(65536), rng.int(65536), rng.int(65536), rng.int(65536)] })}
>player p1 ${JSON.stringify({ name: 'p1', team: toPackedTeam(teams.p1) })}
>player p2 ${JSON.stringify({ name: 'p2', team: toPackedTeam(teams.p2) })}`);
  await w;
  void stream.writeEnd();
  await Promise.race([Promise.all([p1, p2]), new Promise(r => setTimeout(r, 200))]);
  if (keepLog) result.log = fullLog;
  return result;
}
