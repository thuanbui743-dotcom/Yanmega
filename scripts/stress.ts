// Edge-case stress test: pools packed with mechanics that break bots. Reports crashes, invalid choices,
// timeouts, slow decisions and stalled games per bot.
// Usage: npx tsx scripts/stress.ts [--games 100] [--bots claude/best,claude/battler]
import { Dex } from 'pokemon-showdown';
import { loadLibrary } from '../src/cards';
import { playMatch } from '../src/match';
import { makeBot } from '../src/registry';
import { Rng } from '../src/rng';
import type { Bot, Card } from '../src/types';

const args = process.argv.slice(2);
const arg = (k: string, d: string) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const games = Number(arg('games', '100'));
const bots = arg('bots', 'claude/best,claude/battler').split(',');

const EDGE_SPECIES = new Set(['Ditto', 'Zoroark', 'Zoroark-Hisui', 'Tatsugiri', 'Dondozo', 'Palafin', 'Smeargle', 'Indeedee', 'Indeedee-F',
  'Cramorant', 'Mimikyu', 'Eiscue', 'Morpeko', 'Minior', 'Komala', 'Slaking', 'Regigigas', 'Gholdengo', 'Annihilape', 'Farigiraf',
  'Ursaluna-Bloodmoon', 'Terapagos', 'Ogerpon', 'Ogerpon-Wellspring', 'Calyrex-Shadow', 'Urshifu', 'Kingambit', 'Flutter Mane',
  'Amoonguss', 'Grimmsnarl', 'Shedinja', 'Wobbuffet', 'Aegislash', 'Darmanitan', 'Castform']);
const EDGE_MOVES = new Set(['Transform', 'Perish Song', 'Trick', 'Switcheroo', 'Encore', 'Shed Tail', 'Revival Blessing', 'Ally Switch',
  'Instruct', 'Doodle', 'Skill Swap', 'Destiny Bond', 'Substitute', 'Baton Pass', 'Teleport', 'U-turn', 'Volt Switch', 'Parting Shot',
  'Dragon Tail', 'Whirlwind', 'Roar', 'Circle Throw', 'Fling', 'Imprison', 'Disable', 'Taunt', 'Outrage', 'Petal Dance', 'Solar Beam',
  'Phantom Force', 'Shadow Force', 'Dig', 'Fly', 'Dive', 'Meteor Beam', 'Electro Shot', 'Hyper Beam', 'Giga Impact', 'Focus Punch',
  'Beat Up', 'Pollen Puff', 'Final Gambit', 'Memento', 'Healing Wish', 'Explosion', 'Self-Destruct', 'Last Respects', 'Rage Fist']);

const lib = loadLibrary();
const edge = lib.filter(c => EDGE_SPECIES.has(c.species) || c.moves.some(m => EDGE_MOVES.has(m)));
console.log(`edge cards: ${edge.length}`);

function edgePool(rng: Rng): Card[] {
  const pool: Card[] = [];
  const sp = new Set<string>(), items = new Map<string, number>();
  let guard = 0;
  while (pool.length < 18 && guard++ < 100000) {
    const c = guard < 50000 ? edge[rng.int(edge.length)] : lib[rng.int(lib.length)];
    const base = Dex.species.get(c.species).baseSpecies;
    if (sp.has(base) || (items.get(c.item) ?? 0) >= 2) continue;
    sp.add(base); items.set(c.item, (items.get(c.item) ?? 0) + 1); pool.push(c);
  }
  return pool;
}

// Wrap a bot to record exceptions and the slowest decisions.
function instrument(b: Bot, stats: { errors: string[]; slowest: number; slowPicks: number }): Bot {
  const time = <T>(f: () => T | Promise<T>, label: string) => async () => {
    const t = Date.now();
    try { return await f(); } catch (e: any) { stats.errors.push(`${label}: ${String(e?.stack ?? e).split('\n').slice(0, 3).join(' | ')}`); throw e; }
    finally { const ms = Date.now() - t; stats.slowest = Math.max(stats.slowest, ms); if (ms > 2000) stats.slowPicks++; }
  };
  return {
    name: b.name,
    draftPick: v => time(() => b.draftPick(v), 'draft')(),
    teamPreview: v => time(() => b.teamPreview(v), 'preview')(),
    chooseAction: v => time(() => b.chooseAction(v), 'battle')(),
  };
}

(async () => {
  const rng = new Rng(777);
  const per: Record<string, { errors: string[]; slowest: number; slowPicks: number; invalid: number; timeouts: number; wins: number; games: number }> = {};
  for (const b of bots) per[b] = { errors: [], slowest: 0, slowPicks: 0, invalid: 0, timeouts: 0, wins: 0, games: 0 };
  let crashes = 0, ties = 0, longGames = 0;
  const t0 = Date.now();
  for (let g = 0; g < games; g++) {
    const pool = edgePool(rng);
    const [a, b] = g % 2 ? [bots[1], bots[0]] : [bots[0], bots[1]];
    try {
      const r = await playMatch(5000 + g, instrument(makeBot(a), per[a]), instrument(makeBot(b), per[b]), { pool });
      per[a].games++; per[b].games++;
      per[a].invalid += r.battle.invalid.p1; per[b].invalid += r.battle.invalid.p2;
      per[a].timeouts += r.battle.timeouts.p1; per[b].timeouts += r.battle.timeouts.p2;
      if (r.winner === a) per[a].wins++; else if (r.winner === b) per[b].wins++; else ties++;
      if (r.battle.turns > 40) longGames++;
    } catch (e: any) {
      crashes++;
      console.log(`CRASH game ${g}: ${String(e?.stack ?? e).split('\n').slice(0, 4).join(' | ')}`);
    }
    if ((g + 1) % 20 === 0) console.log(`${g + 1}/${games} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  }
  console.log(`\n${games} edge-case matches in ${((Date.now() - t0) / 1000).toFixed(0)}s | arena crashes ${crashes} | ties ${ties} | games over 40 turns ${longGames}`);
  for (const b of bots) {
    const s = per[b];
    console.log(`${b}: wins ${s.wins}/${s.games} | bot exceptions ${s.errors.length} | invalid ${s.invalid} | timeouts ${s.timeouts} | slowest decision ${s.slowest} ms | decisions over 2 s ${s.slowPicks}`);
    const uniq = [...new Set(s.errors)].slice(0, 5);
    for (const e of uniq) console.log(`   ${e}`);
  }
})();
