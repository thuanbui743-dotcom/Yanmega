// Debug helper: npx tsx bots/claude/battler/debug.ts <seed> [A|B]
import { playMatch } from '../../../src/match';
import { makeBot } from '../../../src/registry';
const seed = Number(process.argv[2] ?? 1);
const side = process.argv[3] ?? 'A';
const opp = process.argv[4] ?? 'greedy';
(async () => {
  const a = side === 'A' ? makeBot('claude/battler') : makeBot(opp);
  const b = side === 'A' ? makeBot(opp) : makeBot('claude/battler');
  const r = await playMatch(seed, a, b, { keepLog: true });
  console.log('WINNER', r.winner, 'turns', r.battle.turns);
  if (process.env.SHOWLOG) console.log(r.log!.filter(l => !l.startsWith('|request') && !l.startsWith('|t:') && l.trim()).join('\n'));
})();
