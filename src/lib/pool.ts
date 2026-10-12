// Pool analysis shared by all bots: real stats, damage between any two cards, speed, and 1v1 outcomes.
import { calculate, Generations, Pokemon, Move, Field } from '@smogon/calc';
import { Dex } from 'pokemon-showdown';
import type { Card, MonState } from '../types';

export const gen = Generations.get(9);

export interface DmgInfo {
  move: string;
  minPct: number;      // % of defender max HP, min roll
  maxPct: number;
  avgPct: number;
  spread: boolean;     // hits both foes (already includes the 0.75 doubles modifier)
  hitsAlly: boolean;   // e.g. Earthquake, Discharge
  priority: number;
}

export interface Mods {
  atkBoosts?: MonState['boosts'];
  defBoosts?: MonState['boosts'];
  atkStatus?: string;
  defStatus?: string;
  defHpPct?: number;
  weather?: string;
  terrain?: string;
}

const monCache = new Map<string, Pokemon>();
export function toCalcMon(c: Card, boosts?: MonState['boosts'], status?: string, hpPct?: number): Pokemon {
  const key = c.id;
  if (!boosts && !status && hpPct === undefined && monCache.has(key)) return monCache.get(key)!;
  // The calc does not know cosmetic formes (Vivillon-Monsoon, Minior-Green); use the base species.
  const sp = gen.species.get(c.species.toLowerCase().replace(/[^a-z0-9]/g, '') as any) ? c.species : Dex.species.get(c.species).baseSpecies;
  const p = new Pokemon(gen, sp, {
    level: c.level, item: c.item as any, ability: c.ability as any, nature: c.nature as any,
    evs: c.evs, ivs: c.ivs, boosts: boosts as any, status: (status || '') as any,
  });
  if (hpPct !== undefined) p.originalCurHP = Math.max(1, Math.round(p.maxHP() * hpPct / 100));
  if (!boosts && !status && hpPct === undefined) monCache.set(key, p);
  return p;
}

const WEATHER: Record<string, string> = { RainDance: 'Rain', SunnyDay: 'Sun', Sandstorm: 'Sand', Snowscape: 'Snow', DesolateLand: 'Harsh Sunshine', PrimordialSea: 'Heavy Rain' };
const TERRAIN: Record<string, string> = { 'Electric Terrain': 'Electric', 'Grassy Terrain': 'Grassy', 'Psychic Terrain': 'Psychic', 'Misty Terrain': 'Misty' };

/** Damage of one specific move. */
export function moveDamage(att: Card, def: Card, moveName: string, mods: Mods = {}): DmgInfo | null {
  const dm = Dex.moves.get(moveName);
  if (!dm.exists || dm.category === 'Status') return null;
  try {
    const a = toCalcMon(att, mods.atkBoosts, mods.atkStatus);
    const d = toCalcMon(def, mods.defBoosts, mods.defStatus, mods.defHpPct);
    const field = new Field({
      gameType: 'Doubles',
      weather: (mods.weather ? WEATHER[mods.weather] : undefined) as any,
      terrain: (mods.terrain ? TERRAIN[mods.terrain] : undefined) as any,
    });
    const r = calculate(gen, a, d, new Move(gen, dm.name), field);
    const [lo, hi] = r.range();
    const max = d.maxHP();
    const rolls = Array.isArray(r.damage) ? (r.damage as any[]).flat() as number[] : [Number(r.damage)];
    const avg = rolls.reduce((s, x) => s + x, 0) / rolls.length;
    return {
      move: dm.name,
      minPct: (lo / max) * 100, maxPct: (hi / max) * 100, avgPct: (avg / max) * 100,
      spread: dm.target === 'allAdjacentFoes' || dm.target === 'allAdjacent',
      hitsAlly: dm.target === 'allAdjacent',
      priority: dm.priority,
    };
  } catch {
    return null;
  }
}

const bestCache = new Map<string, DmgInfo | null>();
/** Best single move from att into def by average damage (no field effects). Cached per card pair. */
export function bestDamage(att: Card, def: Card): DmgInfo | null {
  const key = att.id + '>' + def.id;
  if (bestCache.has(key)) return bestCache.get(key)!;
  let best: DmgInfo | null = null;
  for (const m of att.moves) {
    const d = moveDamage(att, def, m);
    if (d && (!best || d.avgPct > best.avgPct)) best = d;
  }
  bestCache.set(key, best);
  return best;
}

export function stats(c: Card) { return toCalcMon(c).stats; }

/** Speed stat including Choice Scarf. */
export function speed(c: Card): number {
  return Math.floor(stats(c).spe * (c.item === 'Choice Scarf' ? 1.5 : 1));
}

/** 1 = a wins 1v1, 0.5 = even, 0 = a loses (hits-to-KO with speed tiebreak, priority counts as faster). */
export function oneVsOne(a: Card, b: Card): number {
  const da = bestDamage(a, b), db = bestDamage(b, a);
  const ha = da && da.avgPct > 0 ? Math.ceil(100 / da.avgPct) : 99;
  const hb = db && db.avgPct > 0 ? Math.ceil(100 / db.avgPct) : 99;
  if (ha !== hb) return ha < hb ? 1 : 0;
  if (ha === 99) return 0.5;
  const pa = da!.priority, pb = db!.priority;
  if (pa !== pb) return pa > pb ? 1 : 0;
  const sa = speed(a), sb = speed(b);
  return sa === sb ? 0.5 : sa > sb ? 1 : 0;
}

export function hasMove(c: Card, ...names: string[]) { return c.moves.some(m => names.includes(m)); }

export interface PoolAnalysis {
  cards: Card[];
  idx: Map<string, number>;
  dmg: number[][];        // dmg[i][j] = best avg % i deals to j
  win: number[][];        // win[i][j] = oneVsOne(i, j)
  spe: number[];
  power: number[];        // mean win rate vs the rest of the pool
}

export function analyzePool(cards: Card[]): PoolAnalysis {
  const n = cards.length;
  const dmg = cards.map(a => cards.map(b => (a === b ? 0 : bestDamage(a, b)?.avgPct ?? 0)));
  const win = cards.map(a => cards.map(b => (a === b ? 0.5 : oneVsOne(a, b))));
  const power = win.map((row, i) => row.reduce((s, x, j) => s + (i === j ? 0 : x), 0) / (n - 1));
  return { cards, idx: new Map(cards.map((c, i) => [c.id, i])), dmg, win, spe: cards.map(speed), power };
}
