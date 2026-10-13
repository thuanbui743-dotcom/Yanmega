// Offline bridge test: drives adapter/bridge.ts with platform-shaped draft and Team Preview states
// (shapes from https://api.altruagent-game.com/skill/pokemon) through a full snake draft.
import { spawn } from 'child_process';
import * as readline from 'readline';
import * as path from 'path';
import { drawPool } from '../src/cards';
import { Rng } from '../src/rng';
import { SNAKE, legalFor } from '../src/draft';
import type { Card } from '../src/types';

const ME = 'agent-me', OPP = 'agent-opp';
const toPlatform = (c: Card) => ({ card_id: c.id, species: c.species, item: c.item, ability: c.ability, nature: c.nature, level: 50, evs: c.evs, ivs: {}, moves: c.moves });

(async () => {
  const child = spawn(process.execPath, ['--import', 'tsx', path.join(__dirname, 'bridge.ts')], { cwd: path.join(__dirname, '..') });
  const rl = readline.createInterface({ input: child.stdout! });
  const replies: any[] = [];
  let wake: (() => void) | null = null;
  rl.on('line', l => { replies.push(JSON.parse(l)); wake?.(); });
  const next = () => new Promise<any>(res => { const go = () => { if (replies.length) res(replies.shift()); else wake = go; }; go(); });
  const t0 = Date.now();
  console.log('ready:', JSON.stringify(await next()), `${Date.now() - t0} ms`);

  const pool = drawPool(new Rng(42));
  const first = Math.random() < 0.5 ? ME : OPP;
  const rosters: Record<string, Card[]> = { [ME]: [], [OPP]: [] };
  let available = [...pool];
  const picks: any[] = [];
  let id = 0;
  for (let i = 0; i < 12; i++) {
    const seat = SNAKE[i] === 'A' ? first : (first === ME ? OPP : ME);
    const legal = legalFor(rosters[seat], available);
    let card: Card;
    if (seat === ME) {
      const st = {
        phase: 'draft',
        observation: { phase: 'draft', first_drafter: first, current_seat: ME, pick_number: i + 1,
          available_card_ids: available.map(c => c.id), available_cards: available.map(toPlatform), picks },
        legal_actions: { actions: legal.map(c => ({ action_id: `draft_pick:${c.id}`, input: { action: { type: 'draft_pick', card_id: c.id } } })) },
      };
      const t = Date.now();
      child.stdin!.write(JSON.stringify({ id: ++id, agent_id: ME, phase: 'draft', state: st }) + '\n');
      const r = await next();
      card = legal.find(c => c.id === r.action?.card_id)!;
      console.log(`pick ${i + 1} (me): ${r.error ? 'ERROR ' + r.error : card?.species} ${Date.now() - t} ms`);
      if (!card) process.exit(1);
    } else {
      card = legal[0];
    }
    rosters[seat].push(card);
    picks.push({ pick_number: i + 1, seat_id: seat, card_id: card.id, species: card.species });
    available = available.filter(c => c !== card);
  }
  const roster = rosters[ME].map(c => c.species.toLowerCase().replace(/[^a-z0-9]/g, ''));
  const st = {
    phase: 'team_preview',
    observation: { phase: 'team_preview',
      your_roster: rosters[ME].map(c => ({ species: c.species.toLowerCase().replace(/[^a-z0-9]/g, ''), name: c.species })),
      opponent_roster: rosters[OPP].map(c => ({ species: c.species.toLowerCase().replace(/[^a-z0-9]/g, ''), name: c.species })) },
    legal_actions: { actions: [{ action_id: 'select_lineup', input: { action: { type: 'select_lineup', roster } } }] },
  };
  const t = Date.now();
  child.stdin!.write(JSON.stringify({ id: ++id, agent_id: ME, phase: 'team_preview', state: st }) + '\n');
  console.log('preview:', JSON.stringify(await next()), `${Date.now() - t} ms`);
  child.kill();
})();
