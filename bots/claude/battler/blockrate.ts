// usage: VGC_CARDS=platform npx tsx bots/claude/battler/blockrate.ts <me> <opp> <games> <seed>
import { playMatch } from '../../../src/match';
import { makeBot } from '../../../src/registry';
const { analyze } = require('./protstats.js');
const [me = 'claude/best', opp = 'gemini2/field', n = '20', seed = '50000'] = process.argv.slice(2);
(async () => {
  let ours = 0, blocked = 0, wins = 0, g = 0;
  for (let i = 0; i < Number(n); i++) for (const meA of [true, false]) {
    const r = await playMatch(Number(seed) + i, makeBot(meA ? me : opp), makeBot(meA ? opp : me), { keepLog: true });
    const a = analyze(r.log!, meA ? 'p1' : 'p2');
    ours += a.ours; blocked += a.blocked; g++; if (r.winner === me) wins++;
  }
  console.log(`${me} vs ${opp}: games ${g} wins ${wins} | our attacks ${ours} blocked ${blocked} rate ${(blocked / ours).toFixed(3)}`);
  process.exit(0);
})();
