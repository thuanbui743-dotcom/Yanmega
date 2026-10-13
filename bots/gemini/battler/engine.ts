// Gemini Battler: Next-generation VGC Doubles Battle Engine
// Evaluates payoff matrix of legal joint actions vs predicted opponent actions.
import type { BattleView, Card, MonState } from '../../../src/types';
import { moveDamage, stats, DmgInfo, oneVsOne } from '../../../src/lib/pool';
import { slotOptions, jointChoices, SlotOption } from '../../../src/lib/choices';
import { Dex } from 'pokemon-showdown';

export const CONFIG = {
  ALIVE: 40,            // base value of an alive mon
  HP_WEIGHT: 1.0,       // value per % of HP
  SPEED_ADV: 6,         // value for speed advantage next turn
  LAMBDA: 0.72,         // weight of expected value vs worst case
  OPP_TOP_SLOT: 3,      // top actions per opponent slot
  OPP_TOP_JOINT: 6,     // top opponent joint actions in payoff table
  OPP_TEMP: 10,         // softmax temperature for opponent move probabilities
  SCREEN_VAL: 12,       // value of active screen
  ROLLOUT_WEIGHT: 0.8,  // weight of 1-turn rollout in evaluation
  ROLLOUT2_WEIGHT: 0.4, // weight of 2nd rollout turn
  PRUNE_LIMIT: 24,      // candidate joint choices to fully evaluate
  TIE_BREAKER: 0.02,    // slight tiebreaker for immediate damage dealt
  GREEDY_PRIOR_WEIGHT: 0.5, // bonus probability weight given to the exact greedy action
};

// --- Caches ---
const moveCache = new Map<string, any>();
export function getMove(name: string): any {
  let m = moveCache.get(name);
  if (!m) { m = Dex.moves.get(name); moveCache.set(name, m); }
  return m;
}

const typeCache = new Map<string, string[]>();
export function getTypes(c: Card): string[] {
  let t = typeCache.get(c.species);
  if (!t) { t = [...Dex.species.get(c.species).types]; typeCache.set(c.species, t); }
  return t;
}

const statCache = new Map<string, any>();
export function getStats(c: Card) {
  let s = statCache.get(c.id);
  if (!s) { s = stats(c); statCache.set(c.id, s); }
  return s as { hp: number; atk: number; def: number; spa: number; spd: number; spe: number };
}

const PROTECT_MOVES = new Set([
  'Protect', 'Detect', 'Spiky Shield', "King's Shield", 'Baneful Bunker',
  'Silk Trap', 'Burning Bulwark', 'Obstruct', 'Max Guard'
]);
const REDIRECT_MOVES = new Set(['Follow Me', 'Rage Powder']);
const HEAL_MOVES = new Set([
  'Recover', 'Roost', 'Slack Off', 'Soft-Boiled', 'Moonlight', 'Synthesis',
  'Morning Sun', 'Shore Up', 'Milk Drink', 'Strength Sap', 'Heal Order',
  'Lunar Blessing', 'Jungle Healing'
]);
const SLEEP_MOVES = new Set(['Spore', 'Sleep Powder', 'Hypnosis', 'Sing', 'Lovely Kiss', 'Dark Void', 'Yawn']);
const INTIMIDATE_IMMUNE = new Set([
  'Clear Body', 'Hyper Cutter', 'White Smoke', 'Full Metal Body',
  'Inner Focus', 'Oblivious', 'Own Tempo', 'Scrappy', 'Guard Dog', 'Mirror Armor'
]);
const PRIO_BLOCK_ABILITIES = new Set(['Armor Tail', 'Queenly Majesty', 'Dazzling']);
const STAT_DROP_IMMUNE = new Set(['Clear Body', 'White Smoke', 'Full Metal Body', 'Mirror Armor']);

// --- Damage Cache ---
const dmgCache = new Map<string, DmgInfo | null>();
function boostKey(b: Record<string, number>) {
  return `${b.atk ?? 0},${b.def ?? 0},${b.spa ?? 0},${b.spd ?? 0},${b.spe ?? 0}`;
}

export function calcDmg(att: SimMon, def: SimMon, move: string, f: SimField): DmgInfo | null {
  const defFull = def.hp >= 99.5;
  const multi = def.ability === 'Multiscale' || def.ability === 'Shadow Shield';
  const key = `${att.card.id}|${def.card.id}|${move}|${boostKey(att.boosts)}|${boostKey(def.boosts)}|${att.status}|${def.status}|${f.weather}|${f.terrain}|${multi && !defFull ? 0 : 1}`;
  let d = dmgCache.get(key);
  if (d === undefined) {
    d = moveDamage(att.card, def.card, move, {
      atkBoosts: att.boosts,
      defBoosts: def.boosts,
      atkStatus: att.status,
      defStatus: def.status,
      weather: f.weather,
      terrain: f.terrain,
      defHpPct: multi && !defFull ? 50 : undefined,
    });
    if (dmgCache.size > 250000) dmgCache.clear();
    dmgCache.set(key, d);
  }
  return d;
}

// --- Sim Types ---
export interface SimMon {
  side: 0 | 1; // 0 = me, 1 = opp
  slot: number; // 0 or 1, -1 for bench
  card: Card;
  hp: number; // 0..100
  boosts: Record<string, number>;
  status: string;
  fainted: boolean;
  protect: boolean;
  flinch: boolean;
  acted: boolean;
  firstTurn: boolean;
  itemUsed: boolean;
  types: string[];
  ability: string;
  item: string;
  helpingHand: boolean;
  protectedLastTurn: boolean;
  lastMove?: string;
  physical: boolean;
  maxHp: number;
  curMove?: string;
  charging?: string;
  chargeTgt?: number;
  invulnerable?: boolean;
}

export interface SimField {
  tailwind: [number, number];
  trickRoom: number;
  weather: string;
  terrain: string;
  screens: [number, number];
  redirect: [SimMon | null, SimMon | null];
  wideGuard: [boolean, boolean];
}

export interface Action {
  kind: 'move' | 'switch' | 'pass';
  move?: string;
  tgt?: number;
  sw?: SimMon;
}

export interface SimState {
  act: (SimMon | null)[][]; // [side][slot]
  out: SimMon[];
  inn: SimMon[];
  f: SimField;
  bench?: SimMon[][];
}

function isPhys(c: Card) {
  let p = 0, s = 0;
  for (const m of c.moves) {
    const d = getMove(m);
    if (d.category === 'Physical') p += d.basePower || 60;
    else if (d.category === 'Special') s += d.basePower || 60;
  }
  return p >= s;
}

export function createSimMon(side: 0 | 1, slot: number, card: Card, ms: Partial<MonState>): SimMon {
  return {
    side, slot, card,
    hp: ms.hpPct ?? 100,
    boosts: { ...(ms.boosts ?? {}) } as any,
    status: ms.status ?? '',
    fainted: !!ms.fainted || (ms.hpPct ?? 100) <= 0,
    protect: false,
    flinch: false,
    acted: false,
    firstTurn: (ms.turnsOnField ?? 0) <= 1,
    itemUsed: !!ms.itemConsumed,
    types: getTypes(card),
    ability: card.ability,
    item: ms.itemConsumed ? '' : card.item,
    helpingHand: false,
    protectedLastTurn: !!ms.protectedLastTurn,
    lastMove: ms.lastMove,
    physical: isPhys(card),
    maxHp: getStats(card).hp,
  };
}

function cloneMon(m: SimMon): SimMon {
  return { ...m, boosts: { ...m.boosts } };
}

function cloneSim(s: SimState): SimState {
  return {
    act: s.act.map(row => row.map(m => (m ? cloneMon(m) : null))),
    out: [],
    inn: [],
    bench: s.bench,
    f: {
      ...s.f,
      tailwind: [...s.f.tailwind] as [number, number],
      screens: [...s.f.screens] as [number, number],
      redirect: [null, null],
      wideGuard: [false, false],
    },
  };
}

// --- Speed and Priority ---
const speedRankCache = new Map<string, boolean>();
function isSpeedHighestStat(c: Card): boolean {
  let v = speedRankCache.get(c.id);
  if (v === undefined) {
    const x = getStats(c);
    v = x.spe > Math.max(x.atk, x.def, x.spa, x.spd);
    speedRankCache.set(c.id, v);
  }
  return v;
}

const boostMultiplier = (n: number) => (n >= 0 ? (2 + n) / 2 : 2 / (2 - n));

export function effectiveSpeed(m: SimMon, f: SimField, twOverride?: number): number {
  let s = getStats(m.card).spe * boostMultiplier(m.boosts.spe ?? 0);
  if (m.item === 'Choice Scarf') s *= 1.5;
  if (m.item === 'Iron Ball') s *= 0.5;
  const a = m.ability, w = f.weather;
  if ((a === 'Swift Swim' && w === 'RainDance') ||
      (a === 'Chlorophyll' && w === 'SunnyDay') ||
      (a === 'Sand Rush' && w === 'Sandstorm') ||
      (a === 'Slush Rush' && (w === 'Snowscape' || w === 'Snow')) ||
      (a === 'Surge Surfer' && f.terrain === 'Electric Terrain') ||
      (a === 'Unburden' && m.itemUsed && m.card.item !== '')) {
    s *= 2;
  }
  if ((a === 'Protosynthesis' || a === 'Quark Drive') && isSpeedHighestStat(m.card)) {
    const active = a === 'Protosynthesis' ? w === 'SunnyDay' : f.terrain === 'Electric Terrain';
    if (active || m.card.item === 'Booster Energy') s *= 1.5;
  }
  if (a === 'Quick Feet' && m.status) s *= 1.5;
  else if (m.status === 'par') s *= 0.5;

  const tw = twOverride !== undefined ? twOverride : f.tailwind[m.side];
  if (tw > 0) s *= 2;
  return s;
}

function isGrounded(m: SimMon): boolean {
  return !m.types.includes('Flying') && m.ability !== 'Levitate' && m.item !== 'Air Balloon';
}

export function getPriority(m: SimMon, a: Action, f: SimField): number {
  if (a.kind === 'switch') return 7;
  if (a.kind !== 'move' || !a.move) return -8;
  const d = getMove(a.move);
  let p = d.priority || 0;
  if (m.ability === 'Prankster' && d.category === 'Status') p += 1;
  if (m.ability === 'Gale Wings' && d.type === 'Flying' && m.hp >= 99.5) p += 1;
  if (m.ability === 'Triage' && d.flags?.heal) p += 3;
  if (a.move === 'Grassy Glide' && f.terrain === 'Grassy Terrain') p += 1;
  return p;
}

// --- Target resolution ---
function getFoe(s: SimState, m: SimMon, tgt: number | undefined): SimMon | null {
  const opp = s.act[1 - m.side];
  if (tgt && tgt > 0) {
    const t = opp[tgt - 1];
    if (t && !t.fainted) return t;
    const other = opp[2 - tgt];
    return other && !other.fainted ? other : null;
  }
  const alive = opp.filter(x => x && !x.fainted) as SimMon[];
  return alive[0] ?? null;
}

function applyBoosts(t: SimMon, b: Record<string, number>, fromFoe: boolean) {
  if (fromFoe && (STAT_DROP_IMMUNE.has(t.ability) || t.item === 'Covert Cloak' || t.ability === 'Shield Dust')) return;
  for (const k in b) {
    let v = b[k];
    if (t.ability === 'Contrary') v = -v;
    if (t.ability === 'Simple') v *= 2;
    t.boosts[k] = Math.max(-6, Math.min(6, (t.boosts[k] ?? 0) + v));
    if (fromFoe && v < 0 && t.ability === 'Defiant') t.boosts.atk = Math.min(6, (t.boosts.atk ?? 0) + 2);
    if (fromFoe && v < 0 && t.ability === 'Competitive') t.boosts.spa = Math.min(6, (t.boosts.spa ?? 0) + 2);
  }
}

function canInflictStatus(t: SimMon, status: string, f: SimField): boolean {
  if (t.fainted || t.status) return false;
  if (t.ability === 'Purifying Salt' || t.ability === 'Comatose') return false;
  if (f.terrain === 'Misty Terrain' && isGrounded(t)) return false;
  if (status === 'par') return !t.types.includes('Electric') && t.ability !== 'Limber';
  if (status === 'brn') return !t.types.includes('Fire') && t.ability !== 'Water Veil' && t.ability !== 'Water Bubble' && t.ability !== 'Thermal Exchange';
  if (status === 'slp') return !(f.terrain === 'Electric Terrain' && isGrounded(t)) && !['Insomnia', 'Vital Spirit', 'Sweet Veil'].includes(t.ability);
  if (status === 'tox' || status === 'psn') return !t.types.includes('Steel') && !t.types.includes('Poison') && t.ability !== 'Immunity';
  return true;
}

function executeStatusMove(s: SimState, m: SimMon, a: Action) {
  const name = a.move!;
  const d = getMove(name);
  const f = s.f;
  const side = m.side;
  const ally = s.act[side][1 - m.slot];

  if (PROTECT_MOVES.has(name)) {
    if (!m.protectedLastTurn) m.protect = true;
    return;
  }
  if (name === 'Wide Guard') { f.wideGuard[side] = true; return; }
  if (REDIRECT_MOVES.has(name)) { f.redirect[side] = m; return; }
  if (name === 'Helping Hand') {
    if (ally && !ally.fainted && !ally.acted) ally.helpingHand = true;
    return;
  }
  if (name === 'Tailwind') {
    if (f.tailwind[side] <= 0) f.tailwind[side] = 4;
    return;
  }
  if (name === 'Trick Room') {
    f.trickRoom = f.trickRoom > 0 ? 0 : 5;
    return;
  }
  if (name === 'Reflect' || name === 'Light Screen' || name === 'Aurora Veil') {
    if (name !== 'Aurora Veil' || f.weather === 'Snowscape' || f.weather === 'Hail' || f.weather === 'Snow') {
      f.screens[side] += 1;
    }
    return;
  }
  if (HEAL_MOVES.has(name)) { m.hp = Math.min(100, m.hp + 50); return; }
  if (name === 'Life Dew') {
    m.hp = Math.min(100, m.hp + 25);
    if (ally && !ally.fainted) ally.hp = Math.min(100, ally.hp + 25);
    return;
  }
  if (name === 'Haze') {
    for (const row of s.act) for (const x of row) if (x) x.boosts = {};
    return;
  }

  const isFoeTarget = d.target === 'normal' || d.target === 'any' || d.target === 'adjacentFoe';
  if (isFoeTarget) {
    let t = getFoe(s, m, a.tgt);
    const red = f.redirect[1 - side];
    if (red && !red.fainted && red !== t) t = red;
    if (!t || t.fainted) return;
    if (t.protect && d.flags?.protect) return;
    if (m.ability === 'Prankster' && t.types.includes('Dark')) return;
    if (t.ability === 'Good as Gold') return;
    if (d.flags?.powder && (t.types.includes('Grass') || t.ability === 'Overcoat' || t.item === 'Safety Goggles')) return;
    if (d.status && canInflictStatus(t, d.status, f)) {
      if (d.status === 'par' && name === 'Thunder Wave' && t.types.includes('Ground')) return;
      t.status = d.status;
    }
    if (d.boosts) applyBoosts(t, d.boosts, true);
    return;
  }

  if (d.target === 'allAdjacentFoes') {
    for (const t of s.act[1 - side]) {
      if (!t || t.fainted || (t.protect && d.flags?.protect)) continue;
      if (m.ability === 'Prankster' && t.types.includes('Dark')) continue;
      if (d.status && canInflictStatus(t, d.status, f)) t.status = d.status;
      if (d.boosts) applyBoosts(t, d.boosts, true);
    }
    return;
  }

  if (d.boosts && (d.target === 'self' || d.target === 'adjacentAllyOrSelf')) {
    const t = a.tgt && a.tgt < 0 && -a.tgt - 1 !== m.slot ? ally : m;
    if (t && !t.fainted) applyBoosts(t, d.boosts, false);
    return;
  }
  if (d.boosts && (d.target === 'allies' || d.target === 'allySide')) {
    applyBoosts(m, d.boosts, false);
    if (ally && !ally.fainted) applyBoosts(ally, d.boosts, false);
    return;
  }
}

const typeEffCache = new Map<string, boolean>();
function isSuperEffective(moveType: string, defTypes: string[]): boolean {
  const k = moveType + '|' + defTypes.join(',');
  let v = typeEffCache.get(k);
  if (v === undefined) {
    v = Dex.getImmunity(moveType, defTypes) && Dex.getEffectiveness(moveType, defTypes) > 0;
    typeEffCache.set(k, v);
  }
  return v;
}

function applyEndOfTurn(s: SimState) {
  const f = s.f;
  for (const row of s.act) for (const m of row) {
    if (!m || m.fainted) continue;
    const mg = m.ability === 'Magic Guard';
    if (m.item === 'Leftovers' || (m.item === 'Black Sludge' && m.types.includes('Poison'))) m.hp += 6.25;
    if (f.terrain === 'Grassy Terrain' && isGrounded(m)) m.hp += 6.25;
    if (!mg) {
      if (m.status === 'brn') m.hp -= 6.25;
      if (m.status === 'psn' && m.ability !== 'Poison Heal') m.hp -= 12.5;
      if (m.status === 'tox' && m.ability !== 'Poison Heal') m.hp -= 12.5;
      if (f.weather === 'Sandstorm' && !m.types.some(x => x === 'Rock' || x === 'Ground' || x === 'Steel') &&
          !['Overcoat', 'Sand Veil', 'Sand Rush', 'Sand Force'].includes(m.ability) && m.item !== 'Safety Goggles') {
        m.hp -= 6.25;
      }
    }
    if (m.hp > 100) m.hp = 100;
    if (m.hp <= 0) { m.hp = 0; m.fainted = true; }
  }
}

function executeHit(s: SimState, m: SimMon, t: SimMon, a: Action, d: any, nTargets: number, luck: number): number {
  if (t.invulnerable && m.ability !== 'No Guard' && t.ability !== 'No Guard') return 0;
  const f = s.f;
  if (t.protect && d.flags?.protect) return 0;
  if (nTargets > 1 && f.wideGuard[t.side]) return 0;

  if (a.move === 'Sucker Punch' || a.move === 'Thunderclap') {
    if (t.acted || (t.curMove && getMove(t.curMove).category === 'Status')) return 0;
  }

  // Priority blocking
  if (getPriority(m, a, f) > 0 && t.side !== m.side) {
    if ((f.terrain === 'Psychic Terrain' && isGrounded(t)) ||
        PRIO_BLOCK_ABILITIES.has(t.ability) ||
        PRIO_BLOCK_ABILITIES.has(s.act[t.side][1 - t.slot]?.ability ?? '')) {
      return 0;
    }
  }

  const r = calcDmg(m, t, a.move!, f);
  if (!r) return 0;

  const isEruption = a.move === 'Eruption' || a.move === 'Water Spout' || a.move === 'Dragon Energy';
  let amt = luck === 0.5 ? r.avgPct : r.minPct + luck * (r.maxPct - r.minPct);
  if (r.spread && nTargets === 1) amt /= 0.75;
  if (isEruption) amt *= Math.max(0.01, m.hp / 100);
  if (m.helpingHand) amt *= 1.5;
  if (f.screens[t.side] > 0 && t.side !== m.side && a.move !== 'Brick Break' && a.move !== 'Psychic Fangs') amt *= 2 / 3;

  if (d.accuracy !== true && d.accuracy < 100) {
    if (luck === 0.5) amt *= d.accuracy / 100;
    else if (d.accuracy < 100 * (1 - luck) + 1e-9 && luck < 0.5) amt = 0;
  }

  // Focus Sash / Sturdy
  if (amt >= t.hp && t.hp >= 99.5 && (t.item === 'Focus Sash' || t.ability === 'Sturdy')) {
    amt = t.hp - 1;
  }
  // Disguise
  if (t.hp >= 99.5 && t.ability === 'Disguise' && t.card.species.startsWith('Mimikyu')) {
    amt = 12;
  }

  amt = Math.min(amt, t.hp);
  t.hp -= amt;
  if (t.hp <= 0.01) { t.hp = 0; t.fainted = true; }

  // Secondaries
  const sec = d.secondary;
  if (sec && sec.chance >= 100 && r.avgPct > 0 && !t.fainted && t.ability !== 'Shield Dust' && t.item !== 'Covert Cloak') {
    if (sec.volatileStatus === 'flinch' && !t.acted && t.ability !== 'Inner Focus') t.flinch = true;
    if (sec.boosts) applyBoosts(t, sec.boosts, true);
    if (sec.status && canInflictStatus(t, sec.status, f)) t.status = sec.status;
  }

  // On-hit items/abilities
  if (amt > 0 && !t.fainted) {
    if (t.item === 'Weakness Policy' && isSuperEffective(d.type, t.types)) {
      applyBoosts(t, { atk: 2, spa: 2 }, false);
      t.item = ''; t.itemUsed = true;
    }
    if (t.item === 'Sitrus Berry' && t.hp < 50) {
      t.hp = Math.min(100, t.hp + 25);
      t.item = ''; t.itemUsed = true;
    }
    if (d.flags?.contact && m.ability !== 'Magic Guard' && m.item !== 'Protective Pads' && m.ability !== 'Long Reach') {
      let rec = 0;
      if (t.item === 'Rocky Helmet') rec += 100 / 6;
      if (t.ability === 'Rough Skin' || t.ability === 'Iron Barbs') rec += 12.5;
      m.hp -= rec;
    }
  }

  // Recoil / Drain
  const scale = t.maxHp / m.maxHp;
  if (d.recoil && m.ability !== 'Rock Head' && m.ability !== 'Magic Guard') {
    m.hp -= amt * scale * d.recoil[0] / d.recoil[1];
  }
  if (d.drain) {
    m.hp = Math.min(100, m.hp + amt * scale * d.drain[0] / d.drain[1]);
  }

  return amt;
}

const CHARGE_INVULN = new Set(['Fly', 'Bounce', 'Dig', 'Dive', 'Phantom Force', 'Shadow Force']);
function isChargeSkip(m: SimMon, move: string, f: SimField): boolean {
  if (m.item === 'Power Herb') return true;
  if ((move === 'Solar Beam' || move === 'Solar Blade') && f.weather === 'SunnyDay') return true;
  if (move === 'Electro Shot' && f.weather === 'RainDance') return true;
  return false;
}

function executeMove(s: SimState, m: SimMon, a: Action, luck: number) {
  const d = getMove(a.move!);
  if (a.move === 'Fake Out' || a.move === 'First Impression') {
    if (!m.firstTurn) return;
  }
  if (d.category === 'Status') {
    executeStatusMove(s, m, a);
    return;
  }

  if (d.flags?.charge) {
    if (m.charging) {
      m.charging = undefined;
      m.invulnerable = false;
    } else if (!isChargeSkip(m, a.move!, s.f)) {
      m.charging = a.move;
      m.chargeTgt = a.tgt;
      if (CHARGE_INVULN.has(a.move!)) m.invulnerable = true;
      if (a.move === 'Meteor Beam' || a.move === 'Electro Shot') applyBoosts(m, { spa: 1 }, false);
      if (a.move === 'Skull Bash') applyBoosts(m, { def: 1 }, false);
      m.lastMove = a.move;
      return;
    }
  }

  const f = s.f;
  let targets: SimMon[] = [];
  if (d.target === 'allAdjacentFoes' || d.target === 'allAdjacent') {
    targets = s.act[1 - m.side].filter(x => x && !x.fainted) as SimMon[];
    if (d.target === 'allAdjacent') {
      const ally = s.act[m.side][1 - m.slot];
      if (ally && !ally.fainted) targets.push(ally);
    }
  } else if (a.tgt && a.tgt < 0) {
    const t = s.act[m.side][-a.tgt - 1];
    if (t && !t.fainted) targets = [t];
  } else {
    let t = getFoe(s, m, a.tgt);
    const red = f.redirect[1 - m.side];
    if (red && !red.fainted && t !== red && m.ability !== 'Stalwart' && m.ability !== 'Propeller Tail' && a.move !== 'Snipe Shot') {
      const powderImmune = m.types.includes('Grass') || m.ability === 'Overcoat' || m.item === 'Safety Goggles';
      if (!(powderImmune && f.redirect[1 - m.side] && red.lastMove === 'Rage Powder')) t = red;
    }
    if (t) targets = [t];
  }

  let totalDealt = 0;
  for (const t of targets) totalDealt += executeHit(s, m, t, a, d, targets.length, luck);
  m.helpingHand = false;
  m.lastMove = a.move;

  if (totalDealt > 0 && m.item === 'Life Orb' && m.ability !== 'Magic Guard' && m.ability !== 'Sheer Force') {
    m.hp -= 10;
  }
  if (d.self?.boosts && targets.length) applyBoosts(m, d.self.boosts, false);
  if (d.secondary?.self?.boosts && d.secondary.chance >= 100 && totalDealt > 0) applyBoosts(m, d.secondary.self.boosts, false);
  if (d.selfdestruct === 'always' || (d.selfdestruct === 'ifHit' && totalDealt > 0)) {
    m.hp = 0;
    m.fainted = true;
  }
  if (d.mindBlownRecoil && m.ability !== 'Magic Guard') {
    m.hp -= 50;
  }
  if (m.hp <= 0.01) { m.hp = 0; m.fainted = true; }
}

export function simulateTurn(s: SimState, acts: (Action | null)[][], luck = 0.5) {
  const f = s.f;
  type QueueItem = { m: SimMon; a: Action; side: number; slot: number };
  const queue: QueueItem[] = [];

  // Switches first
  for (let side = 0; side < 2; side++) for (let slot = 0; slot < 2; slot++) {
    const a = acts[side][slot];
    if (a?.kind === 'switch' && a.sw) {
      const old = s.act[side][slot];
      if (old) { old.boosts = {}; s.out.push(old); }
      const nextMon = cloneMon(a.sw);
      nextMon.slot = slot;
      nextMon.side = side as 0 | 1;
      nextMon.acted = true;
      nextMon.firstTurn = false;
      s.act[side][slot] = nextMon;
      s.inn.push(a.sw);
      if (nextMon.ability === 'Intimidate') {
        for (const t of s.act[1 - side]) {
          if (t && !t.fainted && !INTIMIDATE_IMMUNE.has(t.ability)) applyBoosts(t, { atk: -1 }, true);
        }
      }
    }
  }

  // Fast priority (Protect, Wide Guard, Redirection)
  for (let side = 0; side < 2; side++) for (let slot = 0; slot < 2; slot++) {
    const a = acts[side][slot], m = s.act[side][slot];
    if (m) m.curMove = a?.kind === 'move' ? a.move : undefined;
    if (!a || !m || m.fainted || a.kind !== 'move' || !a.move) continue;
    const name = a.move;
    if (PROTECT_MOVES.has(name) || name === 'Wide Guard') {
      executeStatusMove(s, m, a);
      m.acted = true;
    } else {
      if (REDIRECT_MOVES.has(name)) { f.redirect[side] = m; }
      if (name === 'Helping Hand') {
        const ally = s.act[side][1 - slot];
        if (ally && !ally.fainted) ally.helpingHand = true;
        m.acted = true;
        continue;
      }
      queue.push({ m, a, side, slot });
    }
  }

  // Process moves in dynamic speed order
  while (queue.length) {
    let bestIdx = 0, bestPrio = -99, bestSpe = 0;
    for (let i = 0; i < queue.length; i++) {
      const q = queue[i];
      const p = getPriority(q.m, q.a, f);
      let sp = effectiveSpeed(q.m, f);
      if (f.trickRoom > 0) sp = -sp;
      // Slight tiebreak: give opponent edge for minimax robustness
      sp += q.side === 1 ? 0.001 : 0;
      if (p > bestPrio || (p === bestPrio && sp > bestSpe)) {
        bestIdx = i; bestPrio = p; bestSpe = sp;
      }
    }
    const q = queue.splice(bestIdx, 1)[0];
    const m = q.m;
    if (m.fainted || s.act[q.side][q.slot] !== m) continue;
    if (m.flinch || m.status === 'slp' || m.status === 'frz') {
      m.acted = true;
      continue;
    }
    executeMove(s, m, q.a, luck);
    m.acted = true;
  }

  applyEndOfTurn(s);
}

// --- Position Evaluation ---
function boostScore(m: SimMon) {
  const b = m.boosts;
  const off = m.physical ? (b.atk ?? 0) : (b.spa ?? 0);
  return 12 * off + 6 * ((b.def ?? 0) + (b.spd ?? 0)) / 2;
}

function statusScore(m: SimMon) {
  switch (m.status) {
    case 'brn': return m.physical ? -25 : -8;
    case 'par': return -12;
    case 'slp': return -35;
    case 'frz': return -35;
    case 'tox': return -15;
    case 'psn': return -8;
  }
  return 0;
}

function monValue(m: SimMon, onField: boolean): number {
  if (m.fainted || m.hp <= 0) return 0;
  return CONFIG.ALIVE + CONFIG.HP_WEIGHT * m.hp + (onField ? boostScore(m) : 0) + statusScore(m);
}

export function evalState(s: SimState): number {
  let v = 0;
  let myAlive = 0, oppAlive = 0;

  for (const side of [0, 1]) {
    const sign = side === 0 ? 1 : -1;
    for (const m of s.act[side]) {
      if (m && !m.fainted && m.hp > 0) {
        v += sign * monValue(m, true);
        if (side === 0) myAlive++; else oppAlive++;
      }
    }
  }

  for (const m of s.out) v += (m.side === 0 ? 1 : -1) * monValue(m, false);
  for (const m of s.inn) v -= (m.side === 0 ? 1 : -1) * monValue(m, false);

  // Bonus for KO advantage
  v += (myAlive - oppAlive) * 25;

  // Speed advantage next turn

  const f = s.f;
  const tw: [number, number] = [f.tailwind[0] - 1, f.tailwind[1] - 1];
  const tr = f.trickRoom - 1 > 0;
  for (const a of s.act[0]) for (const b of s.act[1]) {
    if (!a || !b || a.fainted || b.fainted) continue;
    const sa = effectiveSpeed(a, f, tw[0]), sb = effectiveSpeed(b, f, tw[1]);
    if (sa === sb) continue;
    v += ((sa > sb) !== tr ? 1 : -1) * CONFIG.SPEED_ADV;
  }

  v += CONFIG.SCREEN_VAL * (Math.min(f.screens[0], 2) - Math.min(f.screens[1], 2));
  return v;
}

// --- Rollout and Preparation ---
function fillBenchReplacements(s: SimState) {
  if (!s.bench) return;
  for (const side of [0, 1]) for (const slot of [0, 1]) {
    const cur = s.act[side][slot];
    if (cur && !cur.fainted) continue;
    const taken = (b: SimMon) => s.inn.includes(b) ||
      s.act[side].some(x => x && x.card.id === b.card.id) ||
      s.out.some(x => x.card.id === b.card.id);
    const available = s.bench[side].filter(b => !taken(b));
    if (!available.length) continue;
    let pick = available[0];
    if (side === 0 && available.length > 1) {
      let bestMatch = -Infinity;
      for (const cand of available) {
        const sc = computeMatchupScore(cand, s);
        if (sc > bestMatch) { bestMatch = sc; pick = cand; }
      }
    }
    const nextMon = cloneMon(pick);
    nextMon.slot = slot;
    nextMon.side = side as 0 | 1;
    nextMon.firstTurn = true;
    if (cur) s.out.push(cur);
    s.act[side][slot] = nextMon;
    s.inn.push(pick);
  }
}

function prepNextTurn(s: SimState) {
  fillBenchReplacements(s);
  for (const row of s.act) for (const m of row) if (m) {
    m.protectedLastTurn = m.protect;
    m.protect = false;
    m.flinch = false;
    m.acted = false;
    m.firstTurn = false;
    m.helpingHand = false;
  }
  s.f.tailwind = [Math.max(0, s.f.tailwind[0] - 1), Math.max(0, s.f.tailwind[1] - 1)];
  s.f.trickRoom = Math.max(0, s.f.trickRoom - 1);
  s.f.redirect = [null, null];
  s.f.wideGuard = [false, false];
}

function computeRolloutValue(s: SimState): number {
  const v1 = evalState(s);
  if (CONFIG.ROLLOUT_WEIGHT <= 0) return v1;

  prepNextTurn(s);
  const theirs = getTopJointActions(s, 1, 2, 1)[0].acts;
  const mine = getTopJointActions(s, 0, 2, 1)[0].acts;
  simulateTurn(s, [mine, theirs]);
  let v2 = evalState(s);

  if (CONFIG.ROLLOUT2_WEIGHT > 0) {
    prepNextTurn(s);
    simulateTurn(s, [getTopJointActions(s, 0, 2, 1)[0].acts, getTopJointActions(s, 1, 2, 1)[0].acts]);
    const v3 = evalState(s);
    v2 = (1 - CONFIG.ROLLOUT2_WEIGHT) * v2 + CONFIG.ROLLOUT2_WEIGHT * v3;
  }

  return (1 - CONFIG.ROLLOUT_WEIGHT) * v1 + CONFIG.ROLLOUT_WEIGHT * v2;
}

// --- Opponent Move Prediction ---
interface CandidateAction { act: Action; h: number; kills: number[] }

function getSlotCandidates(s: SimState, side: 0 | 1, slot: number): CandidateAction[] {
  const m = s.act[side][slot];
  if (!m || m.fainted) return [{ act: { kind: 'pass' }, h: 0, kills: [] }];
  const out: CandidateAction[] = [];
  const foes = s.act[1 - side];

  if (m.charging) {
    return m.chargeTgt ? [{ act: { kind: 'move', move: m.charging, tgt: m.chargeTgt }, h: 50, kills: [] }]
      : [1, 2].filter(x => foes[x - 1] && !foes[x - 1]!.fainted).map(x => ({ act: { kind: 'move' as const, move: m.charging, tgt: x }, h: 50, kills: [] }));
  }

  let moves = m.card.moves;
  if (m.item.startsWith('Choice') && m.lastMove && moves.includes(m.lastMove)) {
    moves = [m.lastMove];
  }

  let incomingThreat = 0;
  if (m.card.moves.some(x => PROTECT_MOVES.has(x))) {
    for (const e of foes) if (e && !e.fainted) {
      for (const mvn of e.card.moves) {
        const r = calcDmg(e, m, mvn, s.f);
        if (r) incomingThreat = Math.max(incomingThreat, r.avgPct);
      }
    }
  }

  for (const name of moves) {
    const d = getMove(name);
    if (!d.exists) continue;
    if ((name === 'Fake Out' || name === 'First Impression') && !m.firstTurn) continue;

    if (d.category === 'Status') {
      if (m.item === 'Assault Vest') continue;
      let h = 4;
      if (PROTECT_MOVES.has(name)) {
        if (m.protectedLastTurn) continue;
        h = 6 + (incomingThreat >= m.hp ? 32 : incomingThreat >= m.hp * 0.6 ? 14 : 0);
      } else if (name === 'Tailwind') {
        h = s.f.tailwind[side] > 0 ? -20 : 32;
      } else if (name === 'Trick Room') {
        let slower = 0;
        for (const a of s.act[side]) for (const b of foes) {
          if (a && b && !a.fainted && !b.fainted) slower += effectiveSpeed(a, s.f) < effectiveSpeed(b, s.f) ? 1 : -1;
        }
        h = s.f.trickRoom > 0 ? -40 : slower > 0 ? 35 : -10;
      } else if (REDIRECT_MOVES.has(name)) {
        h = 18;
      } else if (name === 'Helping Hand') {
        h = 14;
      } else if (SLEEP_MOVES.has(name)) {
        h = 30;
      } else if (name === 'Thunder Wave' || name === 'Will-O-Wisp' || name === 'Toxic') {
        h = 16;
      } else if (HEAL_MOVES.has(name)) {
        h = Math.max(0, (100 - m.hp) * 0.5 - 5);
      } else if (d.boosts && d.target === 'self') {
        h = 14;
      }

      if (d.target === 'normal' || d.target === 'adjacentFoe' || d.target === 'any') {
        for (const t of [1, 2]) {
          const e = foes[t - 1];
          if (e && !e.fainted) out.push({ act: { kind: 'move', move: name, tgt: t }, h, kills: [] });
        }
      } else {
        out.push({ act: { kind: 'move', move: name }, h, kills: [] });
      }
      continue;
    }

    const isSpread = d.target === 'allAdjacentFoes' || d.target === 'allAdjacent';
    if (isSpread) {
      let h = 0; const kills: number[] = [];
      for (const e of foes) if (e && !e.fainted) {
        const r = calcDmg(m, e, name, s.f);
        if (r) {
          h += Math.min(r.avgPct, e.hp);
          if (r.minPct >= e.hp) { h += 50; kills.push(e.slot); }
        }
      }
      if (d.target === 'allAdjacent') {
        const ally = s.act[side][1 - slot];
        if (ally && !ally.fainted) {
          const r = calcDmg(m, ally, name, s.f);
          if (r) h -= 1.5 * Math.min(r.avgPct, ally.hp) + (r.avgPct >= ally.hp ? 80 : 0);
        }
      }
      if (name === 'Fake Out') h += 38;
      out.push({ act: { kind: 'move', move: name }, h, kills });
    } else {
      for (const t of [1, 2]) {
        const e = foes[t - 1];
        if (!e || e.fainted) continue;
        const r = calcDmg(m, e, name, s.f);
        let h = 0; const kills: number[] = [];
        if (r) {
          h = Math.min(r.avgPct, e.hp);
          if (r.minPct >= e.hp) { h += 50; kills.push(e.slot); }
        }
        if (name === 'Fake Out') h += 38;
        if (d.secondary?.chance >= 100 && d.secondary.boosts?.spe) h += 6;
        out.push({ act: { kind: 'move', move: name, tgt: t }, h, kills });
      }
    }
  }

  for (const c of out) {
    if (c.act.move && getMove(c.act.move).flags?.charge && !isChargeSkip(m, c.act.move, s.f)) {
      c.h *= 0.5;
      c.kills = [];
    }
  }

  if (!out.length) out.push({ act: { kind: 'pass' }, h: 0, kills: [] });
  out.sort((a, b) => b.h - a.h);
  return out;
}

function getTopJointActions(s: SimState, side: 0 | 1, perSlot: number, top: number): { acts: Action[]; h: number }[] {
  const c0 = getSlotCandidates(s, side, 0), c1 = getSlotCandidates(s, side, 1);
  const pick = (c: CandidateAction[]) => {
    const r = c.slice(0, perSlot);
    const prot = c.find(x => x.act.move && PROTECT_MOVES.has(x.act.move));
    if (prot && !r.includes(prot)) r.push(prot);
    return r;
  };
  const a0 = pick(c0), a1 = pick(c1);
  const joint: { acts: Action[]; h: number }[] = [];
  for (const x of a0) for (const y of a1) {
    let h = x.h + y.h;
    if (x.kills.length && y.kills.length && x.kills.some(k => y.kills.includes(k))) h -= 40;
    joint.push({ acts: [x.act, y.act], h });
  }
  joint.sort((a, b) => b.h - a.h);
  return joint.slice(0, top);
}

// Predict exact greedy joint action for side 1
function predictGreedyAction(s: SimState): Action[] {
  const foes = s.act[0]; // my mons from opp's perspective
  const oppActive = s.act[1];

  const val = (slot: number, o: Action): { v: number; tgt?: number; kill?: boolean } => {
    if (o.kind === 'pass') return { v: 0 };
    if (o.kind === 'switch') return { v: -5 };
    const me = oppActive[slot];
    if (!me?.card || !o.move) return { v: 1 };
    if (o.move === 'Fake Out') return { v: me.firstTurn ? 45 : -50 };

    const hit = (t: SimMon | null) => {
      if (!t?.card) return { d: 0, kill: false };
      const d = calcDmg(me, t, o.move!, s.f);
      if (!d) return { d: 0, kill: false };
      return { d: Math.min(d.avgPct, t.hp), kill: d.minPct >= t.hp };
    };

    if (o.tgt && o.tgt > 0) {
      const t = foes[o.tgt - 1];
      const h = hit(t);
      return { v: h.d + (h.kill ? 50 : 0), tgt: o.tgt, kill: h.kill };
    }
    if (o.tgt && o.tgt < 0) return { v: -100 };

    const a = hit(foes[0]), b = hit(foes[1]);
    let total = a.d + b.d + (a.kill ? 50 : 0) + (b.kill ? 50 : 0);
    const ally = oppActive[1 - slot];
    const dm = getMove(o.move);
    if (dm?.target === 'allAdjacent' && ally?.card) {
      const h = hit(ally);
      total -= 1.5 * h.d + (h.kill ? 100 : 0);
    }
    if (o.move === 'Protect' || o.move === 'Detect') total = me.protectedLastTurn ? -20 : 2;
    return { v: total || 1 };
  };

  const c0 = getSlotCandidates(s, 1, 0).map(c => c.act);
  const c1 = getSlotCandidates(s, 1, 1).map(c => c.act);

  let bestScore = -Infinity;
  let bestJoint: Action[] = [c0[0], c1[0]];

  for (const a of c0) for (const b of c1) {
    const v0 = val(0, a);
    const v1 = val(1, b);
    let tot = v0.v + v1.v;
    if (v0.kill && v1.kill && v0.tgt === v1.tgt) tot -= 60;
    if (tot > bestScore) {
      bestScore = tot;
      bestJoint = [a, b];
    }
  }

  return bestJoint;
}

// --- Forced Switch Position Evaluation ---
function computeMatchupScore(c: SimMon, sim: SimState): number {
  let sc = c.hp * 0.35;
  for (const e of sim.act[1]) {
    if (!e || e.fainted) continue;
    let off = 0, def = 0;
    for (const m of c.card.moves) {
      const r = calcDmg(c, e, m, sim.f);
      if (r) off = Math.max(off, Math.min(r.avgPct, e.hp));
    }
    for (const m of e.card.moves) {
      const r = calcDmg(e, c, m, sim.f);
      if (r) def = Math.max(def, Math.min(r.avgPct, c.hp));
    }
    const faster = (effectiveSpeed(c, sim.f) > effectiveSpeed(e, sim.f)) !== (sim.f.trickRoom > 0);
    sc += off * (faster ? 1.3 : 1) - def * (faster ? 1 : 1.3);
    if (off >= e.hp) sc += faster ? 30 : 10;
    if (def >= c.hp) sc -= faster ? 10 : 30;
  }
  return sc;
}

function evaluatePosition(sim: SimState): number {
  const oppJ = getTopJointActions(sim, 1, 3, 5);
  const maxH = Math.max(...oppJ.map(o => o.h));
  const w = oppJ.map(o => Math.exp((o.h - maxH) / CONFIG.OPP_TEMP));
  const wsum = w.reduce((a, b) => a + b, 0);
  const mine = getTopJointActions(sim, 0, 3, 8);
  let best = -Infinity;

  for (const mj of mine) {
    let ev = 0, worst = Infinity;
    for (let k = 0; k < oppJ.length; k++) {
      const s = cloneSim(sim);
      simulateTurn(s, [mj.acts, oppJ[k].acts]);
      const val = computeRolloutValue(s);
      ev += val * w[k] / wsum;
      if (val < worst) worst = val;
    }
    best = Math.max(best, CONFIG.LAMBDA * ev + (1 - CONFIG.LAMBDA) * worst);
  }
  return best;
}

// --- Building Sim State from BattleView ---
export function buildSimFromView(v: BattleView): { sim: SimState; myBench: Map<number, SimMon> } {
  const st0 = v.state;
  const fs = st0.field;
  const f: SimField = {
    tailwind: [fs.tailwind.me, fs.tailwind.opp],
    trickRoom: fs.trickRoom,
    weather: fs.weather,
    terrain: fs.terrain,
    screens: [
      fs.screens.me.filter(x => /Reflect|Light Screen|Aurora Veil/.test(x)).length,
      fs.screens.opp.filter(x => /Reflect|Light Screen|Aurora Veil/.test(x)).length,
    ],
    redirect: [null, null],
    wideGuard: [false, false],
  };

  const act: (SimMon | null)[][] = [[null, null], [null, null]];
  const req = v.request;
  const myBench = new Map<number, SimMon>();
  const reqMons: any[] = req.side?.pokemon ?? [];

  const findMine = (p: any): { card?: Card; ms?: MonState } => {
    const name = p.ident.split(': ')[1];
    const ms = st0.my.find(m => m.ident.endsWith(': ' + name));
    const sp = p.details.split(',')[0];
    const card = ms?.card ?? v.myTeam.find(c => c.species === sp || c.species === name);
    return { card, ms };
  };

  let slot = 0;
  reqMons.forEach((p, i) => {
    const { card, ms } = findMine(p);
    const cond = String(p.condition);
    const fainted = cond.endsWith(' fnt') || cond.startsWith('0');
    const [cur, max] = cond.split(' ')[0].split('/').map(Number);
    const hpPct = fainted ? 0 : max ? (cur / max) * 100 : 100;
    const status = cond.split(' ')[1] ?? '';
    if (p.active) {
      const s = slot++;
      if (card && !fainted) {
        act[0][s] = createSimMon(0, s, card, { ...(ms ?? {}), hpPct, status: status === 'fnt' ? '' : status });
      }
    } else if (card && !fainted) {
      myBench.set(i + 1, createSimMon(0, -1, card, { hpPct, status, boosts: {}, turnsOnField: 5 }));
    }
  });

  // Opponent mons on field (with Illusion fix)
  for (const m of st0.opp) {
    if (!m.active || m.fainted || m.slot < 0) continue;
    // Illusion check: if m.species doesn't match m.card, re-resolve from oppTeam
    let card = m.card;
    if (card && card.species !== m.species) {
      const trueCard = v.oppTeam.find(c => c.species === m.species);
      if (trueCard) card = trueCard;
    }
    if (!card) continue;
    act[1][m.slot] = createSimMon(1, m.slot, card, m);
  }

  // Two-turn move charging from log
  const log = st0.log;
  let end = log.length - 1;
  while (end >= 0 && !log[end].startsWith('|turn|')) end--;
  let start = end - 1;
  while (start >= 0 && !log[start].startsWith('|turn|')) start--;
  for (let i = Math.max(0, start); i < end; i++) {
    const l = log[i];
    if (!l.startsWith('|-prepare|')) continue;
    const parts = l.split('|');
    const id = parts[2], mvName = parts[3];
    const sideIdx = id.startsWith(st0.mySide) ? 0 : 1;
    const name = id.split(': ')[1];
    for (const m of act[sideIdx]) {
      if (m && m.card && (m.card.species === name || st0[sideIdx ? 'opp' : 'my'].some(x => x.active && x.slot === m.slot && x.ident.endsWith(': ' + name)))) {
        m.charging = mvName; m.chargeTgt = undefined;
        if (CHARGE_INVULN.has(mvName)) m.invulnerable = true;
      }
    }
  }

  const oppBench: SimMon[] = [];
  for (const m of st0.opp) {
    if (!m.active && !m.fainted && m.card) {
      oppBench.push(createSimMon(1, -1, m.card, { ...m, boosts: {}, turnsOnField: 5 }));
    }
  }

  const unrevealed = 4 - st0.opp.length;
  if (unrevealed > 0) {
    const seen = new Set(st0.opp.map(m => m.card?.id));
    const rest = v.oppTeam.filter(c => !seen.has(c.id)).map(c => ({
      c, s: v.myTeam.reduce((a, o) => a + oneVsOne(c, o), 0)
    })).sort((a, b) => b.s - a.s);
    for (const r of rest.slice(0, unrevealed)) {
      oppBench.push(createSimMon(1, -1, r.c, { hpPct: 100, turnsOnField: 5 }));
    }
  }

  return {
    sim: { act, out: [], inn: [], f, bench: [[...myBench.values()], oppBench] },
    myBench,
  };
}

export function optToAction(o: SlotOption, bench: Map<number, SimMon>): Action {
  if (o.kind === 'switch') return { kind: 'switch', sw: bench.get(o.switchTo!) };
  if (o.kind === 'pass' || !o.move) return { kind: 'pass' };
  if (o.move === 'Struggle') return { kind: 'pass' };
  return { kind: 'move', move: o.move, tgt: o.target };
}

// --- Main Decision Function ---
export function chooseBattleAction(v: BattleView): string {
  const req = v.request;
  const opts = slotOptions(req);
  const joints = jointChoices(opts);
  if (joints.length === 1) return joints[0].choice;

  const { sim, myBench } = buildSimFromView(v);

  // Forced switch
  if (req.forceSwitch) {
    let best = joints[0].choice, bestVal = -Infinity;
    for (const j of joints) {
      const s = cloneSim(sim);
      const placed = new Set<number>();
      j.parts.forEach((p, slot) => {
        if (p.kind !== 'switch') return;
        const b = myBench.get(p.switchTo!);
        if (!b) return;
        const n = cloneMon(b);
        n.slot = slot; n.side = 0; n.firstTurn = true;
        s.act[0][slot] = n;
        placed.add(p.switchTo!);

        // Entry abilities on switch
        if (n.ability === 'Intimidate') {
          for (const t of s.act[1]) {
            if (t && !t.fainted && !INTIMIDATE_IMMUNE.has(t.ability)) applyBoosts(t, { atk: -1 }, true);
          }
        }
        if (n.ability === 'Drizzle') s.f.weather = 'RainDance';
        else if (n.ability === 'Drought' || n.ability === 'Orichalcum Pulse') s.f.weather = 'SunnyDay';
        else if (n.ability === 'Sand Stream') s.f.weather = 'Sandstorm';
        else if (n.ability === 'Snow Warning') s.f.weather = 'Snowscape';
        else if (n.ability === 'Electric Surge' || n.ability === 'Hadron Engine') s.f.terrain = 'Electric Terrain';
        else if (n.ability === 'Psychic Surge') s.f.terrain = 'Psychic Terrain';
        else if (n.ability === 'Grassy Surge') s.f.terrain = 'Grassy Terrain';
        else if (n.ability === 'Misty Surge') s.f.terrain = 'Misty Terrain';
      });
      let val = evaluatePosition(s);
      for (const [k, b] of myBench) if (!placed.has(k)) val += monValue(b, false);
      if (val > bestVal) { bestVal = val; best = j.choice; }
    }
    return best;
  }

  // Predict opponent joint actions
  const oppJ = getTopJointActions(sim, 1, CONFIG.OPP_TOP_SLOT, CONFIG.OPP_TOP_JOINT);
  const greedyActs = predictGreedyAction(sim);

  // Check if greedy prediction is already in oppJ, otherwise insert it
  const greedyIdx = oppJ.findIndex(o =>
    o.acts[0]?.move === greedyActs[0]?.move && o.acts[0]?.tgt === greedyActs[0]?.tgt &&
    o.acts[1]?.move === greedyActs[1]?.move && o.acts[1]?.tgt === greedyActs[1]?.tgt
  );
  if (greedyIdx < 0 && oppJ.length > 0) {
    oppJ.unshift({ acts: greedyActs, h: oppJ[0].h + 10 });
  }

  const maxH = Math.max(...oppJ.map(o => o.h));
  const w = oppJ.map((o, idx) => {
    let weight = Math.exp((o.h - maxH) / CONFIG.OPP_TEMP);
    if (idx === (greedyIdx >= 0 ? greedyIdx : 0)) {
      weight *= (1 + CONFIG.GREEDY_PRIOR_WEIGHT);
    }
    return weight;
  });
  const wsum = w.reduce((a, b) => a + b, 0);

  // Filter candidates
  const candidates: { j: typeof joints[number]; myActs: (Action | null)[]; tie: number }[] = [];
  for (const j of joints) {
    const myActs = [0, 1].map(i => (j.parts[i] ? optToAction(j.parts[i], myBench) : null));
    if (myActs.some(a => a?.kind === 'switch' && !a.sw)) continue;
    // Don't Protect twice in a row
    if (myActs.some((a, i) => a?.move && PROTECT_MOVES.has(a.move) && sim.act[0][i]?.protectedLastTurn)) continue;

    let tie = 0;
    myActs.forEach((a, i) => {
      const me = sim.act[0][i];
      if (!me || !a?.move || !a.tgt || a.tgt < 0) return;
      const t = sim.act[1][a.tgt - 1];
      if (!t || t.fainted) return;
      const r = calcDmg(me, t, a.move, sim.f);
      if (r) {
        const md = getMove(a.move);
        if (md.selfdestruct) tie -= 100;
        else tie += Math.min(r.avgPct, t.hp) * (r.avgPct >= t.hp ? 2 : 1);
      }
    });
    candidates.push({ j, myActs, tie });
  }

  const scoreJoint = (myActs: (Action | null)[]) => {
    let ev = 0, worst = Infinity;
    for (let k = 0; k < oppJ.length; k++) {
      const s = cloneSim(sim);
      simulateTurn(s, [myActs, oppJ[k].acts], 0.5);
      const val = computeRolloutValue(s);
      ev += val * w[k] / wsum;
      if (val < worst) worst = val;
    }
    return { ev, worst, score: CONFIG.LAMBDA * ev + (1 - CONFIG.LAMBDA) * worst };
  };

  let pool = candidates;
  if (CONFIG.PRUNE_LIMIT > 0 && candidates.length > CONFIG.PRUNE_LIMIT) {
    // Quick 0-rollout pass to prune
    pool = candidates.map(c => {
      let qev = 0;
      for (let k = 0; k < Math.min(3, oppJ.length); k++) {
        const s = cloneSim(sim);
        simulateTurn(s, [c.myActs, oppJ[k].acts], 0.5);
        qev += evalState(s);
      }
      return { c, s: qev + CONFIG.TIE_BREAKER * c.tie };
    }).sort((a, b) => b.s - a.s).slice(0, CONFIG.PRUNE_LIMIT).map(x => x.c);
  }

  let bestChoice = joints[0].choice;
  let bestScore = -Infinity;

  for (const { j, myActs, tie } of pool) {
    const { score: sc } = scoreJoint(myActs);
    const totalScore = sc + CONFIG.TIE_BREAKER * tie;
    if (totalScore > bestScore) {
      bestScore = totalScore;
      bestChoice = j.choice;
    }
  }

  return bestChoice;
}
