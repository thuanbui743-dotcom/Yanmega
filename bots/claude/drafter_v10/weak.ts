// Shared type weaknesses: penalties for stacked weaknesses and an "exploit" score for counter-picking.
import { Dex } from 'pokemon-showdown';
import type { Card } from '../../../src/types';

const TYPES = Dex.types.names().filter(t => t !== 'Stellar');
const effCache = new Map<string, number[]>(); // per species: effectiveness multiplier for each type in TYPES
export function effRow(species: string): number[] {
  let r = effCache.get(species);
  if (!r) {
    const ty = Dex.species.get(species).types;
    r = TYPES.map(t => (!Dex.getImmunity(t, ty) ? 0 : 2 ** Dex.getEffectiveness(t, ty)));
    effCache.set(species, r);
  }
  return r;
}

function moveEffectivePower(c: Card, d: any): number {
  let bp = d.basePower || 0;
  if (d.multihit) {
    if (Array.isArray(d.multihit)) {
      const hits = c.item === 'Loaded Dice' ? 4.5 : 3.2;
      bp = d.basePower * hits;
    } else if (typeof d.multihit === 'number') {
      bp = d.basePower * d.multihit;
    }
  } else if (d.name === 'Triple Axel') {
    bp = 120;
  } else if (d.name === 'Population Bomb') {
    bp = c.item === 'Wide Lens' ? 180 : 120;
  } else if (d.name === 'Surging Strikes') {
    bp = 25 * 3 * 1.5;
  } else if (bp === 0) {
    if (['Low Kick', 'Grass Knot', 'Heavy Slam', 'Heat Crash', 'Gyro Ball'].includes(d.name)) bp = 85;
    else if (d.name === 'Foul Play') bp = 95;
    else if (['Final Gambit', 'Endeavor', 'Ruination', 'Super Fang'].includes(d.name)) bp = 60;
  }
  if (c.ability === 'Technician' && bp <= 60 && !d.multihit) bp *= 1.5;
  return bp;
}

const atkCache = new Map<string, number[]>(); // per card: attack weight per type
export function atkRow(c: Card): number[] {
  let r = atkCache.get(c.id);
  if (!r) {
    const ty = Dex.species.get(c.species).types;
    r = TYPES.map(() => 0);
    for (const name of c.moves) {
      const d = Dex.moves.get(name);
      if (!d.exists || d.category === 'Status') continue;
      const k = TYPES.indexOf(d.type);
      if (k < 0) continue;
      const stab = ty.includes(d.type);
      const bp = moveEffectivePower(c, d);
      const isPrio = d.priority > 0;
      const w = stab && (bp >= 50 || isPrio) ? 1 : (bp >= 65 || (bp >= 40 && isPrio)) ? 0.5 : 0;
      if (w > r[k]) r[k] = w;
    }
    atkCache.set(c.id, r);
  }
  return r;
}

/** Stacked-weakness penalty of team T given opposing attackers O (their roster plus what they can still take, weighted). */
export function stackPenalty(T: Card[], attackW: number[]): number {
  let pen = 0;
  for (let k = 0; k < TYPES.length; k++) {
    let q = 0, d = 0, res = 0;
    for (const c of T) { const e = effRow(c.species)[k]; if (e >= 4) q++; if (e >= 2) d++; if (e < 1) res++; }
    const bad = Math.max(0, q - 1) + 0.5 * Math.max(0, d - 2 - res);
    if (bad > 0) pen += bad * (0.5 + attackW[k]);
  }
  return pen;
}

/** Attack weight per type summed over cards. */
export function attackWeights(O: Card[]): number[] {
  const w = TYPES.map(() => 0);
  for (const c of O) { const r = atkRow(c); for (let k = 0; k < w.length; k++) w[k] += r[k]; }
  return w;
}

/** How well card x exploits team T's weaknesses: weak members hit super-effectively by x's attacks, normalized. */
export function exploit(x: Card, T: Card[]): number {
  if (!T.length) return 0;
  const r = atkRow(x);
  let s = 0;
  for (const c of T) {
    const e = effRow(c.species);
    let best = 0;
    for (let k = 0; k < r.length; k++) if (r[k] > 0 && e[k] >= 2) best = Math.max(best, r[k] * (e[k] >= 4 ? 1.5 : 1));
    s += best;
  }
  return s / T.length;
}

/** Bring penalty: 2+ brought mons 4x weak to a type the opponent attacks with. */
export function bringPenalty(B: Card[], attackW: number[]): number {
  let pen = 0;
  for (let k = 0; k < attackW.length; k++) {
    if (attackW[k] < 0.5) continue;
    let q = 0;
    for (const c of B) if (effRow(c.species)[k] >= 4) q++;
    if (q >= 2) pen += (q - 1) * Math.min(2, attackW[k]);
  }
  return pen;
}
