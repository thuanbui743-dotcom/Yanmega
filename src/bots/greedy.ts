// Baseline: drafts by 1v1 pool power, brings its 4 best vs the opponent, attacks for max expected damage.
import type { Bot, Card, MonState } from '../types';
import { analyzePool, moveDamage, PoolAnalysis, oneVsOne } from '../lib/pool';
import { slotOptions, jointChoices, SlotOption } from '../lib/choices';

export const greedyBot = (): Bot => {
  let pa: PoolAnalysis | null = null;
  return {
    name: 'greedy',
    draftPick: v => {
      if (!pa || pa.cards !== v.pool) pa = analyzePool(v.pool);
      const p = pa;
      return v.legal.reduce((b, c) => (p.power[p.idx.get(c.id)!] > p.power[p.idx.get(b.id)!] ? c : b)).id;
    },
    teamPreview: v => {
      const score = (c: Card) => v.oppTeam.reduce((s, o) => s + oneVsOne(c, o), 0);
      const order = v.myTeam.map((c, i) => ({ i, s: score(c) })).sort((a, b) => b.s - a.s).map(x => x.i);
      return { order: order.slice(0, 4) };
    },
    chooseAction: v => {
      const req = v.request;
      const opts = slotOptions(req);
      const myActive: (MonState | undefined)[] = [0, 1].map(s => v.state.my.find(m => m.active && m.slot === s));
      const foes: (MonState | undefined)[] = [0, 1].map(s => v.state.opp.find(m => m.active && m.slot === s && !m.fainted));
      const ally = (s: number) => myActive[1 - s];
      const val = (slot: number, o: SlotOption): { v: number; tgt?: number; kill?: boolean } => {
        if (o.kind === 'pass') return { v: 0 };
        if (o.kind === 'switch') return { v: -5 };
        const me = myActive[slot];
        if (!me?.card || !o.move) return { v: 1 };
        if (o.move === 'Fake Out') return { v: me.turnsOnField <= 1 ? 45 : -50 };
        const hit = (t: MonState | undefined) => {
          if (!t?.card) return { d: 0, kill: false };
          const d = moveDamage(me.card!, t.card, o.move!, {
            atkBoosts: me.boosts, defBoosts: t.boosts, weather: v.state.field.weather, terrain: v.state.field.terrain,
          });
          if (!d) return { d: 0, kill: false };
          return { d: Math.min(d.avgPct, t.hpPct), kill: d.minPct >= t.hpPct };
        };
        if (o.target && o.target > 0) {
          const t = foes[o.target - 1];
          const h = hit(t);
          return { v: h.d + (h.kill ? 50 : 0), tgt: o.target, kill: h.kill };
        }
        if (o.target && o.target < 0) return { v: -100 };
        // Spread or self moves.
        const a = hit(foes[0]), b = hit(foes[1]);
        let s = a.d + b.d + (a.kill ? 50 : 0) + (b.kill ? 50 : 0);
        const dm = moveDamage(me.card, me.card, o.move);
        if (dm?.hitsAlly && ally(slot)?.card) { const h = hit(ally(slot)); s -= 1.5 * h.d + (h.kill ? 100 : 0); }
        if (o.move === 'Protect' || o.move === 'Detect') s = me.protectedLastTurn ? -20 : 2;
        return { v: s || 1 };
      };
      let best = { choice: 'default', v: -Infinity };
      for (const j of jointChoices(opts)) {
        const vs = j.parts.map((p, s) => val(s, p));
        let total = vs.reduce((s, x) => s + x.v, 0);
        // Overkill: both slots KO-ing the same target wastes one.
        if (vs.length === 2 && vs[0].kill && vs[1].kill && vs[0].tgt === vs[1].tgt) total -= 60;
        if (total > best.v) best = { choice: j.choice, v: total };
      }
      return best.choice;
    },
  };
};
