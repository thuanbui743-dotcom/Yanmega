// Regression test: Revival Blessing requests (pick a fainted party member) must never crash or go invalid.
// The forcing bot leads its Revival Blessing user and uses the move whenever a teammate has fainted;
// every other decision, including the reviving request itself, is answered by final/bot.
import { loadLibrary } from '../src/cards';
import { runBattle } from '../src/battle';
import { makeBot } from '../src/registry';
import { slotOptions, jointChoices } from '../src/lib/choices';
import type { Bot } from '../src/types';
const lib = loadLibrary();
const rb = lib.filter(c => c.moves.includes('Revival Blessing'));
const forcing = (): Bot => {
  const f = makeBot('final/bot');
  return {
    name: 'forcing',
    draftPick: v => v.legal[0].id,
    teamPreview: () => ({ order: [0, 1, 2, 3] }),
    chooseAction: async v => {
      const req = v.request;
      if (!req.forceSwitch && req.active && req.side.pokemon.some((p: any) => p.condition.endsWith(' fnt'))) {
        const opts = slotOptions(req);
        const parts = opts.map(o => o.find(x => x.move === 'Revival Blessing') ?? o.find(x => x.kind === 'move') ?? o[0]);
        if (parts.some(p => p.move === 'Revival Blessing')) {
          const joint = jointChoices(opts).find(j => j.parts.every((p, i) => p.choice === parts[i].choice));
          if (joint) return joint.choice;
        }
      }
      return f.chooseAction(v);
    },
  };
};
(async () => {
  let invalid = 0, timeouts = 0, revivals = 0, revived = 0;
  for (let g = 0; g < 40; g++) {
    const used = new Set<string>(), items = new Set<string>();
    const team = (first: any) => {
      const t = [first]; used.add(first.species); items.add(first.item);
      while (t.length < 6) { const c = lib[Math.floor(Math.random() * lib.length)]; if (used.has(c.species) || items.has(c.item)) continue; used.add(c.species); items.add(c.item); t.push(c); }
      items.clear(); return t;
    };
    const p1 = team(rb[g % rb.length]), p2 = team(rb[(g + 1) % rb.length]);
    const r = await runBattle({ p1, p2 }, { p1: forcing(), p2: makeBot('greedy') }, { keepLog: true, seed: g });
    invalid += r.invalid.p1; timeouts += r.timeouts.p1;
    revivals += r.log!.filter(l => l.startsWith('|move|p1') && l.includes('Revival Blessing')).length;
    revived += r.log!.filter(l => l.startsWith('|-heal|p1') && l.includes('[from] move: Revival Blessing')).length;
  }
  console.log(`40 games | Revival Blessing used ${revivals} times, revived ${revived} | p1 invalid ${invalid} | p1 timeouts ${timeouts}`);
})();
