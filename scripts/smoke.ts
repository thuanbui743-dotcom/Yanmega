import { loadLibrary } from '../src/cards';
import { playMatch } from '../src/match';
import { randomBot } from '../src/bots/random';

(async () => {
  let t = Date.now();
  const lib = loadLibrary();
  console.log(`library: ${lib.length} cards (${Date.now() - t} ms)`);
  t = Date.now();
  const n = Number(process.argv[2] ?? 10);
  let invalid = 0, timeouts = 0, turns = 0;
  for (let i = 0; i < n; i++) {
    const r = await playMatch(1000 + i, { ...randomBot(), name: 'r1' }, { ...randomBot(), name: 'r2' }, { keepLog: i === 0 });
    invalid += r.battle.invalid.p1 + r.battle.invalid.p2;
    timeouts += r.battle.timeouts.p1 + r.battle.timeouts.p2 + r.draftTimeouts;
    turns += r.battle.turns;
    if (i === 0) console.log(r.log!.filter(l => /^\|(switch|move|faint|win|turn|error)/.test(l)).slice(0, 25).join('\n'));
    console.log(`#${i} winner=${r.winner} turns=${r.battle.turns} invalid=${JSON.stringify(r.battle.invalid)} brought=${r.battle.brought.p1.length}/${r.battle.brought.p2.length}`);
  }
  console.log(`${n} matches in ${Date.now() - t} ms, avg turns ${(turns / n).toFixed(1)}, invalid ${invalid}, timeouts ${timeouts}`);
})();
