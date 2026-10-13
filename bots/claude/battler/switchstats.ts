// Voluntary switch statistics from fresh arena games.
// usage: VGC_CARDS=bss npx tsx bots/claude/battler/switchstats.ts <me> <opp> <games> [seed]
import { playMatch } from '../../../src/match';
import { makeBot } from '../../../src/registry';
import { loadLibrary } from '../../../src/cards';
import { moveDamage } from '../../../src/lib/pool';
import type { Card } from '../../../src/types';

const [meId = 'claude/battler', oppId = 'claude/battler_v6', nStr = '40', seedStr = '9000'] = process.argv.slice(2);
const lib = new Map(loadLibrary().map(c => [c.id, c]));

const S = { sw: 0, targeted: 0, lossIn: 0, lossCf: 0, cfN: 0, chains: 0, t1double: 0, t1games: 0, turns: 0, games: 0, wins: 0, chainGames: 0, chainWins: 0, switchTurnLoss: 0 };

(async () => {
  const N = Number(nStr);
  for (let g = 0; g < N; g++) {
    for (const meA of [true, false]) {
      const seed = Number(seedStr) + g;
      const r = await playMatch(seed, makeBot(meA ? meId : oppId), makeBot(meA ? oppId : meId), { keepLog: true });
      const mine = meA ? 'p1' : 'p2', theirs = meA ? 'p2' : 'p1';
      const myCards = (meA ? r.picks.A : r.picks.B).map(id => lib.get(id)!) as Card[];
      const oppCards = (meA ? r.picks.B : r.picks.A).map(id => lib.get(id)!) as Card[];
      const cardOf = (cards: Card[], species: string) => cards.find(c => c.species === species) ?? cards.find(c => species.startsWith(c.species.split('-')[0]));
      const won = r.winner === meId && (meA ? r.sides.A === meId : r.sides.B === meId);
      S.games++; if (won) S.wins++;
      const log = r.log!;
      const hp = new Map<string, number>();        // "p1: Name" -> hp %
      const species = new Map<string, string>();   // "p1: Name" -> species
      const occupant: Record<string, string> = {}; // "p1a" -> "p1: Name"
      const parseHp = (cond: string) => { if (!cond || cond.startsWith('0')) return 0; const [c, m] = cond.split(' ')[0].split('/').map(Number); return m ? (100 * c) / m : 100; };
      const key = (id: string) => id.slice(0, 2) + ': ' + id.split(': ')[1];
      let turn = 0, seenAction = false;
      let lastSwitchTurn: Record<string, number> = {};
      let t1sw = 0, chainInGame = false;
      let pending: { slot: string; incoming: string; outgoing: string; outHp: number; inHp: number; turn: number }[] = [];
      const flush = () => {
        for (const p of pending) {
          const segTargets = turnMoves.filter(m => m.tgt === p.slot);
          if (segTargets.length) S.targeted++;
          const inLoss = p.inHp - (hp.get(p.incoming) ?? 0);
          S.lossIn += inLoss;
          const oc = cardOf(myCards, species.get(p.outgoing) ?? '');
          if (oc) {
            let cf = 0;
            for (const m of segTargets) {
              const ac = cardOf(oppCards, species.get(m.att) ?? '');
              if (!ac) continue;
              const d = moveDamage(ac, oc, m.move);
              if (d) cf += d.avgPct;
            }
            S.lossCf += Math.min(cf, p.outHp); S.cfN++;
          }
        }
        pending = [];
      };
      let turnMoves: { att: string; move: string; tgt: string }[] = [];
      for (const line of log) {
        const p = line.split('|');
        if (p[1] === 'turn') { flush(); turn = Number(p[2]); seenAction = false; turnMoves = []; S.turns++; continue; }
        if (p[1] === 'move' || p[1] === 'cant') seenAction = true;
        if (p[1] === 'move' && p[2].startsWith(theirs) && p[4] && p[4].startsWith(mine)) turnMoves.push({ att: key(p[2]), move: p[3], tgt: p[4].slice(0, 3) });
        if (p[1] === 'switch' || p[1] === 'drag') {
          const slot = p[2].slice(0, 3), id = key(p[2]);
          species.set(id, p[3].split(',')[0]);
          const prev = occupant[slot];
          occupant[slot] = id;
          const h = parseHp(p[4]);
          if (p[2].startsWith(mine) && turn > 0 && !seenAction && prev) {
            S.sw++;
            if (lastSwitchTurn[slot] === turn - 1) { S.chains++; chainInGame = true; }
            lastSwitchTurn[slot] = turn;
            if (turn === 1) t1sw++;
            pending.push({ slot, incoming: id, outgoing: prev, outHp: hp.get(prev) ?? 100, inHp: h, turn });
          }
          hp.set(id, h);
          continue;
        }
        if (p[1] === '-damage' || p[1] === '-heal' || p[1] === '-sethp') { hp.set(key(p[2]), parseHp(p[3])); continue; }
        if (p[1] === 'faint') hp.set(key(p[2]), 0);
      }
      flush();
      if (t1sw >= 2) S.t1double++;
      if (chainInGame) { S.chainGames++; if (won) S.chainWins++; }
    }
  }
  const f = (x: number) => x.toFixed(2);
  console.log(`${meId} vs ${oppId}: games ${S.games} win ${f(S.wins / S.games)} | voluntary switches ${S.sw} (${f(S.sw / S.turns)} per side-turn)`);
  console.log(`  targeted slot ${f(S.targeted / Math.max(1, S.sw))} | avg HP lost by switch-in ${f(S.lossIn / Math.max(1, S.sw))} vs original would lose ${f(S.lossCf / Math.max(1, S.cfN))}`);
  console.log(`  consecutive-turn switches ${S.chains} | games with chains ${S.chainGames} win ${f(S.chainWins / Math.max(1, S.chainGames))} | turn-1 double switches ${S.t1double}`);
  process.exit(0);
})();
