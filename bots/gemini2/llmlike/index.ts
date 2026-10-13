// Stand-in for the starter LLM agent: plays from what that agent is shown (species, move base power,
// type, category, accuracy, targets, HP) with type-chart knowledge but no damage calc or speed tracking.
import type { Bot, Card, MonState } from '../../../src/types';
import { slotOptions, jointChoices, SlotOption } from '../../../src/lib/choices';
import { Dex } from 'pokemon-showdown';

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function rng(seed: string) {
  let x = hash(seed) || 1;
  return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return ((x >>> 0) % 100000) / 100000; };
}
const bst = (c: Card) => { const b = Dex.species.get(c.species).baseStats; return b.hp + b.atk + b.def + b.spa + b.spd + b.spe; };
const offense = (c: Card) => { const b = Dex.species.get(c.species).baseStats; return Math.max(b.atk, b.spa); };
const types = (sp: string) => Dex.species.get(sp).types;
function eff(moveType: string, defSpecies: string): number {
  const t = types(defSpecies);
  if (!Dex.getImmunity(moveType, t)) return 0;
  return Math.pow(2, Dex.getEffectiveness(moveType, t));
}
const PROTECTS = new Set(['Protect', 'Detect', 'Spiky Shield', "King's Shield", 'Baneful Bunker', 'Silk Trap', 'Burning Bulwark', 'Obstruct']);

export default (): Bot => ({
  name: 'llmlike',
  draftPick: v => {
    const r = rng('draft' + v.pickIndex + v.pool.map(c => c.id).join());
    let best = v.legal[0], bv = -Infinity;
    for (const c of v.legal) {
      const s = bst(c) + (bst(c) >= 600 ? 40 : 0) + offense(c) * 0.3 + r() * 40;
      if (s > bv) { bv = s; best = c; }
    }
    return best.id;
  },
  teamPreview: v => {
    const idx = v.myTeam.map((c, i) => ({ i, s: bst(c) })).sort((a, b) => b.s - a.s).slice(0, 4);
    const leads = [...idx].sort((a, b) => offense(v.myTeam[b.i]) - offense(v.myTeam[a.i])).slice(0, 2).map(x => x.i);
    return { order: [...leads, ...idx.map(x => x.i).filter(i => !leads.includes(i))] };
  },
  chooseAction: v => {
    const req = v.request;
    const opts = slotOptions(req);
    const turn = v.state.field.turn;
    const r = rng(`${v.state.mySide}|${turn}|${v.myTeam.map(c => c.id).join()}|${req.rqid ?? ''}`);
    const foes: (MonState | undefined)[] = [0, 1].map(s => v.state.opp.find(m => m.active && m.slot === s && !m.fainted));
    const mine: (MonState | undefined)[] = [0, 1].map(s => v.state.my.find(m => m.active && m.slot === s));
    if (req.forceSwitch) {
      // first strong-looking bench mon
      const js = jointChoices(opts);
      let best = js[0].choice, bv = -Infinity;
      for (const j of js) {
        let s = 0;
        for (const p of j.parts) if (p.kind === 'switch') { const sp = req.side.pokemon[p.switchTo! - 1].details.split(',')[0]; s += Dex.species.get(sp).bst + r() * 60; }
        if (s > bv) { bv = s; best = j.choice; }
      }
      return best;
    }
    const val = (slot: number, o: SlotOption): number => {
      if (o.kind === 'pass') return 0;
      if (o.kind === 'switch') return r() < 0.05 ? 60 : 1;
      const me = mine[slot];
      if (!o.move || !me) return 1;
      const dm = Dex.moves.get(o.move);
      if (o.target && o.target < 0) return -50;
      if (PROTECTS.has(o.move)) return r() < 0.15 ? 200 : 0;
      if (o.move === 'Fake Out') return me.turnsOnField <= 1 ? 90 + r() * 40 : -20;
      if (dm.category === 'Status') return r() < 0.12 ? 120 : 5 * r();
      const myTypes = types(me.species);
      const stab = myTypes.includes(dm.type) ? 1.5 : 1;
      const acc = dm.accuracy === true ? 1 : dm.accuracy / 100;
      const bp = (dm.basePower || 60) * stab * acc;
      const tval = (f: MonState | undefined) => (f ? eff(dm.type, f.species) * (f.hpPct < 50 ? 1.1 : 1) : 0);
      let s: number;
      if (o.target && o.target > 0) {
        let tgt = o.target;
        if (r() < 0.15) tgt = 3 - tgt; // sometimes misreads the board
        s = bp * tval(foes[tgt - 1]);
      } else if (dm.target === 'allAdjacentFoes' || dm.target === 'allAdjacent') {
        s = bp * 0.75 * (tval(foes[0]) + tval(foes[1])) * 1.1;
        if (dm.target === 'allAdjacent' && mine[1 - slot]) s -= bp * 0.5 * eff(dm.type, mine[1 - slot]!.species);
      } else s = bp * 0.5;
      return s * (0.8 + 0.4 * r());
    };
    let best = 'default', bv = -Infinity;
    const cache = opts.map((os, slot) => new Map(os.map(o => [o.choice, val(slot, o)])));
    for (const j of jointChoices(opts)) {
      const s = j.parts.reduce((a, p, i) => a + (cache[i]?.get(p.choice) ?? 0), 0);
      if (s > bv) { bv = s; best = j.choice; }
    }
    return best;
  },
});
