// Field Simulator Bot: A faithful implementation of the typical field competitor spec.
// Implements draft, Team Preview, and battle per MAC_FIELD_TASK.md.
import { Dex } from 'pokemon-showdown';
import type { Bot, Card, DraftView, PreviewView, PreviewChoice, BattleView, MonState, Side } from '../../../src/types';
import { analyzePool, moveDamage, speed, oneVsOne, bestDamage, PoolAnalysis, stats } from '../../../src/lib/pool';
import { slotOptions, jointChoices, SlotOption } from '../../../src/lib/choices';

const ALL_TYPES = [
  'Normal', 'Fire', 'Water', 'Grass', 'Electric', 'Ice',
  'Fighting', 'Poison', 'Ground', 'Flying', 'Psychic', 'Bug',
  'Rock', 'Ghost', 'Dragon', 'Steel', 'Dark', 'Fairy',
];

// Helper to check if card has any of the given moves
function hasMove(c: Card, ...names: string[]): boolean {
  return c.moves.some(m => names.includes(m));
}

// Dual-type damage effectiveness multiplier against a species/card
function typeMultiplier(moveType: string, defSpecies: string, ability?: string, item?: string): number {
  if (moveType === 'Ground') {
    if (ability === 'Levitate' || item === 'Air Balloon') return 0;
  }
  const types = Dex.species.get(defSpecies).types;
  let mult = 1;
  for (const t of types) {
    if (!Dex.getImmunity(moveType, [t])) return 0;
    const eff = Dex.getEffectiveness(moveType, t);
    if (eff > 0) mult *= 2;
    else if (eff < 0) mult *= 0.5;
  }
  return mult;
}

function isWeakTo(type: string, c: Card): boolean {
  return typeMultiplier(type, c.species, c.ability, c.item) > 1;
}

function resistsOrImmune(type: string, c: Card): boolean {
  return typeMultiplier(type, c.species, c.ability, c.item) < 1;
}

function getMoveTypeAndEffectiveBP(c: Card, m: string): { type: string; bp: number; exists: boolean; category: string; target: string } {
  const dm = Dex.moves.get(m);
  if (!dm.exists) return { type: 'Normal', bp: 0, exists: false, category: 'Status', target: 'normal' };
  let type = dm.type;
  let bp = dm.basePower;

  if (m === 'Judgment' && c.species.startsWith('Arceus-')) {
    type = c.species.split('-')[1];
    bp = 100;
  } else if (m === 'Ivy Cudgel') {
    if (c.species.includes('Wellspring')) type = 'Water';
    else if (c.species.includes('Hearthflame')) type = 'Fire';
    else if (c.species.includes('Cornerstone')) type = 'Rock';
    else type = 'Grass';
    bp = 100;
  } else if (m === 'Raging Bull') {
    if (c.species.includes('Blaze')) type = 'Fire';
    else if (c.species.includes('Aqua')) type = 'Water';
    else if (c.species.includes('Combat')) type = 'Fighting';
    bp = 90;
  } else if (m === 'Revelation Dance') {
    type = Dex.species.get(c.species).types[0];
    bp = 90;
  } else if (m === 'Multi-Attack' && c.species.startsWith('Silvally-')) {
    type = c.species.split('-')[1];
    bp = 120;
  } else if (m === 'Flower Trick') {
    bp = 105;
  } else if (m === 'Surging Strikes' || m === 'Wicked Blow') {
    bp = 112.5;
  } else if (m === 'Triple Axel') {
    bp = 120;
  } else if (m === 'Population Bomb') {
    bp = 200;
  } else if (m === 'Dual Wingbeat') {
    bp = 80;
  } else if (['Scale Shot', 'Icicle Spear', 'Bullet Seed', 'Rock Blast', 'Tail Slap'].includes(m)) {
    bp = 100;
  }

  return { type, bp, exists: true, category: dm.category, target: dm.target };
}

// Check if card has a STAB move of 80+ BP
function hasStab80(c: Card): boolean {
  const types = Dex.species.get(c.species).types;
  return c.moves.some(m => {
    const info = getMoveTypeAndEffectiveBP(c, m);
    return info.exists && info.category !== 'Status' && info.bp >= 80 && types.includes(info.type);
  });
}

function hasStabOfType80(c: Card, type: string): boolean {
  const types = Dex.species.get(c.species).types;
  if (!types.includes(type)) return false;
  return c.moves.some(m => {
    const info = getMoveTypeAndEffectiveBP(c, m);
    return info.exists && info.category !== 'Status' && info.bp >= 80 && info.type === type;
  });
}

// STAB spread move with 80+ BP
function hasStabSpread80(c: Card): boolean {
  const types = Dex.species.get(c.species).types;
  return c.moves.some(m => {
    const info = getMoveTypeAndEffectiveBP(c, m);
    return info.exists && info.category !== 'Status' && info.bp >= 80 &&
      types.includes(info.type) && (info.target === 'allAdjacentFoes' || info.target === 'allAdjacent');
  });
}

// Spread move that hits ally
function hasAllyHittingMove(c: Card): boolean {
  return c.moves.some(m => {
    const dm = Dex.moves.get(m);
    return dm.exists && dm.target === 'allAdjacent';
  });
}

function hasProtect(c: Card): boolean {
  return hasMove(c, 'Protect', 'Detect', 'Spiky Shield', 'Baneful Bunker', 'Silk Trap', 'Burning Bulwark');
}

// Attacker definition
function isAttacker(c: Card): boolean {
  if (hasStab80(c)) return true;
  const s = stats(c);
  const maxOff = Math.max(s.atk, s.spa);
  return maxOff >= 95 && c.moves.some(m => {
    const info = getMoveTypeAndEffectiveBP(c, m);
    return info.exists && info.category !== 'Status' && info.bp >= 80;
  });
}

// Support definitions
function isSpeedControl(c: Card): boolean {
  return hasMove(c, 'Tailwind', 'Trick Room', 'Icy Wind', 'Electroweb', 'Thunder Wave');
}

function isTrickRoomSetter(c: Card): boolean {
  return hasMove(c, 'Trick Room');
}

function isTailwindSetter(c: Card): boolean {
  return hasMove(c, 'Tailwind');
}

function isTRSet(c: Card): boolean {
  return isTrickRoomSetter(c) || ['Brave', 'Quiet', 'Relaxed', 'Sassy'].includes(c.nature);
}

// Weather / terrain abilities and moves
const SUN_SETTER_ABILITIES = ['Drought', 'Orichalcum Pulse'];
const RAIN_SETTER_ABILITIES = ['Drizzle', 'Primordial Sea'];
const SAND_SETTER_ABILITIES = ['Sand Stream'];
const SNOW_SETTER_ABILITIES = ['Snow Warning'];
const ELEC_SETTER_ABILITIES = ['Electric Surge', 'Hadron Engine'];
const PSY_SETTER_ABILITIES = ['Psychic Surge'];

function isSunSetter(c: Card): boolean { return SUN_SETTER_ABILITIES.includes(c.ability) || hasMove(c, 'Sunny Day'); }
function isRainSetter(c: Card): boolean { return RAIN_SETTER_ABILITIES.includes(c.ability) || hasMove(c, 'Rain Dance'); }
function isSandSetter(c: Card): boolean { return SAND_SETTER_ABILITIES.includes(c.ability) || hasMove(c, 'Sandstorm'); }
function isSnowSetter(c: Card): boolean { return SNOW_SETTER_ABILITIES.includes(c.ability) || hasMove(c, 'Snowscape'); }
function isElecSetter(c: Card): boolean { return ELEC_SETTER_ABILITIES.includes(c.ability) || hasMove(c, 'Electric Terrain'); }
function isPsySetter(c: Card): boolean { return PSY_SETTER_ABILITIES.includes(c.ability) || hasMove(c, 'Psychic Terrain'); }

function isWeatherOrTerrainSetterAbility(c: Card): boolean {
  return [...SUN_SETTER_ABILITIES, ...RAIN_SETTER_ABILITIES, ...SAND_SETTER_ABILITIES,
          ...SNOW_SETTER_ABILITIES, ...ELEC_SETTER_ABILITIES, ...PSY_SETTER_ABILITIES,
          'Grassy Surge', 'Misty Surge'].includes(c.ability);
}

function isSunAbuser(c: Card): boolean { return ['Chlorophyll', 'Solar Power', 'Protosynthesis'].includes(c.ability); }
function isRainAbuser(c: Card): boolean { return c.ability === 'Swift Swim' || hasMove(c, 'Thunder', 'Hurricane'); }
function isSandAbuser(c: Card): boolean { return c.ability === 'Sand Rush'; }
function isSnowAbuser(c: Card): boolean { return c.ability === 'Slush Rush' || hasMove(c, 'Blizzard'); }
function isElecAbuser(c: Card): boolean { return c.ability === 'Quark Drive'; }
function isPsyAbuser(c: Card): boolean { return hasMove(c, 'Expanding Force'); }

function getSpeedPercentile(c: Card, pool: Card[]): number {
  const speC = speed(c);
  let slower = 0;
  let ties = 0;
  for (const other of pool) {
    if (other === c) continue;
    const s = speed(other);
    if (s < speC) slower++;
    else if (s === speC) ties++;
  }
  return (slower + 0.5 * ties) / (pool.length - 1);
}

function isSlowAttacker(c: Card, pool: Card[]): boolean {
  return isAttacker(c) && (getSpeedPercentile(c, pool) <= 0.35 || speed(c) <= 80);
}

function isMidAttacker(c: Card, pool: Card[]): boolean {
  const p = getSpeedPercentile(c, pool);
  return isAttacker(c) && p > 0.35 && p < 0.65;
}

function isFastAttacker(c: Card, pool: Card[]): boolean {
  const p = getSpeedPercentile(c, pool);
  return isAttacker(c) && (p >= 0.65 || speed(c) >= 115);
}

function isSlowCard(c: Card, pool: Card[]): boolean {
  return getSpeedPercentile(c, pool) <= 0.35 || speed(c) <= 80;
}

// -------------------------------------------------------------
// DRAFT SCORING: Card score C(i)
// -------------------------------------------------------------
interface PoolScarcity {
  counts: Record<string, number>;
}

function computeScarcity(pool: Card[], pa: PoolAnalysis): PoolScarcity {
  const counts: Record<string, number> = {
    tailwind: 0,
    trickRoom: 0,
    intimidate: 0,
    fakeOut: 0,
    redirection: 0,
    spore: 0,
    otherSleep: 0,
    weatherTerrainAbility: 0,
    stabSpread80: 0,
    speedDrop: 0,
    wideGuard: 0,
    pranksterStatus: 0,
    snarlEtc: 0,
    defiantComp: 0,
    helpingHandTaunt: 0,
    focusSash: 0,
  };

  for (const c of pool) {
    if (hasMove(c, 'Tailwind')) counts.tailwind++;
    if (hasMove(c, 'Trick Room')) counts.trickRoom++;
    if (c.ability === 'Intimidate') counts.intimidate++;
    if (hasMove(c, 'Fake Out')) counts.fakeOut++;
    if (hasMove(c, 'Follow Me', 'Rage Powder')) counts.redirection++;
    if (hasMove(c, 'Spore')) counts.spore++;
    else if (hasMove(c, 'Sleep Powder', 'Hypnosis', 'Yawn', 'Sing', 'Dark Void', 'Grass Whistle')) counts.otherSleep++;
    if (isWeatherOrTerrainSetterAbility(c)) counts.weatherTerrainAbility++;
    if (hasStabSpread80(c)) counts.stabSpread80++;
    if (hasMove(c, 'Icy Wind', 'Electroweb', 'Thunder Wave')) counts.speedDrop++;
    if (hasMove(c, 'Wide Guard')) counts.wideGuard++;
    if (c.ability === 'Prankster' && c.moves.some(m => Dex.moves.get(m).category === 'Status')) counts.pranksterStatus++;
    const snarlCount = ['Snarl', 'Will-O-Wisp', 'Encore', 'Parting Shot'].filter(m => hasMove(c, m)).length;
    counts.snarlEtc += snarlCount;
    if (c.ability === 'Defiant' || c.ability === 'Competitive') counts.defiantComp++;
    const hhCount = ['Helping Hand', 'Taunt'].filter(m => hasMove(c, m)).length;
    counts.helpingHandTaunt += hhCount;
    if (c.item === 'Focus Sash') counts.focusSash++;
  }

  return { counts };
}

function getScarcityMult(roleCount: number): number {
  if (roleCount === 1) return 1.5;
  if (roleCount >= 4) return 0.7;
  return 1.0;
}

// Utility points breakdown per card
interface UtilityBreakdown {
  total: number; // capped at 25
  speedControl: number;
  fakeOut: number;
  intimidate: number;
  redirection: number;
  spreadAttacker: number;
}

function cardUtility(c: Card, pool: Card[], pa: PoolAnalysis, scarcity: PoolScarcity): UtilityBreakdown {
  let uncapped = 0;
  let scPoints = 0;
  let foPoints = 0;
  let intPoints = 0;
  let redirPoints = 0;
  let spreadPoints = 0;

  // Tailwind (9)
  if (hasMove(c, 'Tailwind')) {
    const pts = 9 * getScarcityMult(scarcity.counts.tailwind);
    uncapped += pts;
    scPoints += pts;
  }

  // Trick Room (9 if pool has 3+ slow strong cards, else 4)
  if (hasMove(c, 'Trick Room')) {
    const slowStrongCount = pool.filter(x => isSlowAttacker(x, pool) || (isSlowCard(x, pool) && pa.power[pa.idx.get(x.id)!] >= 0.45)).length;
    const base = slowStrongCount >= 3 ? 9 : 4;
    const pts = base * getScarcityMult(scarcity.counts.trickRoom);
    uncapped += pts;
    scPoints += pts;
  }

  // Intimidate (9)
  if (c.ability === 'Intimidate') {
    const pts = 9 * getScarcityMult(scarcity.counts.intimidate);
    uncapped += pts;
    intPoints += pts;
  }

  // Fake Out (8)
  if (hasMove(c, 'Fake Out')) {
    const pts = 8 * getScarcityMult(scarcity.counts.fakeOut);
    uncapped += pts;
    foPoints += pts;
  }

  // Follow Me / Rage Powder (8)
  if (hasMove(c, 'Follow Me', 'Rage Powder')) {
    const pts = 8 * getScarcityMult(scarcity.counts.redirection);
    uncapped += pts;
    redirPoints += pts;
  }

  // Spore (7), other sleep moves (3)
  if (hasMove(c, 'Spore')) {
    uncapped += 7 * getScarcityMult(scarcity.counts.spore);
  } else if (hasMove(c, 'Sleep Powder', 'Hypnosis', 'Yawn', 'Sing', 'Dark Void', 'Grass Whistle')) {
    uncapped += 3 * getScarcityMult(scarcity.counts.otherSleep);
  }

  // Weather or terrain setting ability (5)
  if (isWeatherOrTerrainSetterAbility(c)) {
    uncapped += 5 * getScarcityMult(scarcity.counts.weatherTerrainAbility);
  }

  // STAB spread move with 80+ BP (5)
  if (hasStabSpread80(c)) {
    const pts = 5 * getScarcityMult(scarcity.counts.stabSpread80);
    uncapped += pts;
    spreadPoints += pts;
  }

  // Icy Wind / Electroweb / Thunder Wave (4)
  if (hasMove(c, 'Icy Wind', 'Electroweb', 'Thunder Wave')) {
    const pts = 4 * getScarcityMult(scarcity.counts.speedDrop);
    uncapped += pts;
    scPoints += pts;
  }

  // Wide Guard (4)
  if (hasMove(c, 'Wide Guard')) {
    uncapped += 4 * getScarcityMult(scarcity.counts.wideGuard);
  }

  // Prankster plus a status move (4)
  if (c.ability === 'Prankster' && c.moves.some(m => Dex.moves.get(m).category === 'Status')) {
    uncapped += 4 * getScarcityMult(scarcity.counts.pranksterStatus);
  }

  // Snarl, Will-O-Wisp, Encore, Parting Shot (3 each)
  for (const m of ['Snarl', 'Will-O-Wisp', 'Encore', 'Parting Shot']) {
    if (hasMove(c, m)) {
      uncapped += 3 * getScarcityMult(scarcity.counts.snarlEtc);
    }
  }

  // Defiant / Competitive (3)
  if (c.ability === 'Defiant' || c.ability === 'Competitive') {
    uncapped += 3 * getScarcityMult(scarcity.counts.defiantComp);
  }

  // Helping Hand, Taunt (2 each)
  for (const m of ['Helping Hand', 'Taunt']) {
    if (hasMove(c, m)) {
      uncapped += 2 * getScarcityMult(scarcity.counts.helpingHandTaunt);
    }
  }

  // Focus Sash (2)
  if (c.item === 'Focus Sash') {
    uncapped += 2 * getScarcityMult(scarcity.counts.focusSash);
  }

  const total = Math.min(25, uncapped);
  return {
    total,
    speedControl: scPoints,
    fakeOut: foPoints,
    intimidate: intPoints,
    redirection: redirPoints,
    spreadAttacker: spreadPoints,
  };
}

function cardScore(c: Card, pool: Card[], pa: PoolAnalysis, scarcity: PoolScarcity): number {
  const i = pa.idx.get(c.id)!;
  const nOther = pool.length - 1;

  // 1. Pool power, 0 to 40
  const poolPower = 40 * pa.power[i];

  // 2. Threat, 0 to 10: fraction of pool i OHKOs
  let ohkoCount = 0;
  for (let j = 0; j < pool.length; j++) {
    if (i === j) continue;
    if (pa.dmg[i][j] >= 100) ohkoCount++;
  }
  const threat = 10 * (ohkoCount / nOther);

  // 3. Bulk, 0 to 10: fraction of pool that cannot 2HKO i
  let cannot2hkoCount = 0;
  for (let j = 0; j < pool.length; j++) {
    if (i === j) continue;
    if (pa.dmg[j][i] < 50) cannot2hkoCount++;
  }
  const bulk = 10 * (cannot2hkoCount / nOther);

  // 4. Speed, 0 to 8: speed percentile (inverted for TR sets)
  const spePct = getSpeedPercentile(c, pool);
  const speedScore = 8 * (isTRSet(c) ? 1 - spePct : spePct);

  // 5. Utility, capped at 25
  const u = cardUtility(c, pool, pa, scarcity);
  const utility = u.total;

  // 6. Penalties
  let penalties = 0;
  // No Protect on non-Choice / non-AV: -4
  const isChoiceOrAV = ['Choice Band', 'Choice Specs', 'Choice Scarf', 'Assault Vest'].includes(c.item);
  if (!hasProtect(c) && !isChoiceOrAV) penalties -= 4;
  // Choice item: -2
  if (['Choice Band', 'Choice Specs', 'Choice Scarf'].includes(c.item)) penalties -= 2;
  // No STAB move of 80+ BP and no utility of 8+: -8
  if (!hasStab80(c) && utility < 8) penalties -= 8;
  // Truant or Slow Start: -10
  if (['Truant', 'Slow Start'].includes(c.ability)) penalties -= 10;
  // Spread move that hits ally: -2
  if (hasAllyHittingMove(c)) penalties -= 2;

  return poolPower + threat + bulk + speedScore + utility + penalties;
}

// -------------------------------------------------------------
// DRAFT: Marginal Value M(c | T)
// -------------------------------------------------------------
function countWeatherSetters(team: Card[]): number {
  const s = new Set<string>();
  for (const c of team) {
    if (isSunSetter(c)) s.add('sun');
    if (isRainSetter(c)) s.add('rain');
    if (isSandSetter(c)) s.add('sand');
    if (isSnowSetter(c)) s.add('snow');
  }
  return s.size;
}

function countFieldPairs(team: Card[]): number {
  let pairs = 0;
  const sunSetters = team.filter(isSunSetter).length;
  const sunAbusers = team.filter(isSunAbuser).length;
  pairs += sunSetters * sunAbusers;

  const rainSetters = team.filter(isRainSetter).length;
  const rainAbusers = team.filter(isRainAbuser).length;
  pairs += rainSetters * rainAbusers;

  const sandSetters = team.filter(isSandSetter).length;
  const sandAbusers = team.filter(isSandAbuser).length;
  pairs += sandSetters * sandAbusers;

  const snowSetters = team.filter(isSnowSetter).length;
  const snowAbusers = team.filter(isSnowAbuser).length;
  pairs += snowSetters * snowAbusers;

  const elecSetters = team.filter(isElecSetter).length;
  const elecAbusers = team.filter(isElecAbuser).length;
  pairs += elecSetters * elecAbusers;

  const psySetters = team.filter(isPsySetter).length;
  const psyAbusers = team.filter(isPsyAbuser).length;
  pairs += psySetters * psyAbusers;

  return pairs;
}

function countTwPairs(team: Card[], pool: Card[]): number {
  const setters = team.filter(isTailwindSetter).length;
  const midAtk = team.filter(c => isMidAttacker(c, pool)).length;
  return setters * midAtk;
}

function countTrPairs(team: Card[], pool: Card[]): number {
  const setters = team.filter(isTrickRoomSetter).length;
  const slowAtk = team.filter(c => isSlowAttacker(c, pool)).length;
  return setters * slowAtk;
}

function isFastNonSupport(c: Card, pool: Card[], u: UtilityBreakdown): boolean {
  const p = getSpeedPercentile(c, pool);
  const fast = p >= 0.65 || speed(c) >= 115;
  const support = isSpeedControl(c) || hasMove(c, 'Fake Out') || c.ability === 'Intimidate' ||
    hasMove(c, 'Follow Me', 'Rage Powder') || u.total >= 8;
  return fast && !support;
}

function marginalValueBase(
  c: Card,
  T: Card[],
  oppTeam: Card[],
  available: Card[],
  pool: Card[],
  pa: PoolAnalysis,
  scarcity: PoolScarcity,
  C_cache: Map<string, number>,
): number {
  const C_c = C_cache.get(c.id)!;
  const u = cardUtility(c, pool, pa, scarcity);
  const teamPlusC = [...T, c];

  // RoleFill:
  // "the roles are SpeedControl, FakeOut, Intimidate, Redirection, SpreadAttacker and Attacker. Multiply c's utility points per role by 1.0 if T has none of that role, 0.4 if T has one, 0.1 if two or more.
  // - When T has 3 cards and no SpeedControl, speed-control cards get +12.
  // - When T has 4 cards and fewer than 2 attackers, attackers get +12."
  let roleFill = 0;
  const tSC = T.filter(isSpeedControl).length;
  const tFO = T.filter(x => hasMove(x, 'Fake Out')).length;
  const tInt = T.filter(x => x.ability === 'Intimidate').length;
  const tRedir = T.filter(x => hasMove(x, 'Follow Me', 'Rage Powder')).length;
  const tSpread = T.filter(hasStabSpread80).length;

  const roleMult = (count: number) => (count === 0 ? 1.0 : count === 1 ? 0.4 : 0.1);

  if (isSpeedControl(c)) roleFill += u.speedControl * (roleMult(tSC) - 1.0);
  if (hasMove(c, 'Fake Out')) roleFill += u.fakeOut * (roleMult(tFO) - 1.0);
  if (c.ability === 'Intimidate') roleFill += u.intimidate * (roleMult(tInt) - 1.0);
  if (hasMove(c, 'Follow Me', 'Rage Powder')) roleFill += u.redirection * (roleMult(tRedir) - 1.0);
  if (hasStabSpread80(c)) roleFill += u.spreadAttacker * (roleMult(tSpread) - 1.0);

  // When T has 3 cards and no SpeedControl, speed-control cards get +12
  if (T.length === 3 && tSC === 0 && isSpeedControl(c)) roleFill += 12;
  // When T has 4 cards and fewer than 2 attackers, attackers get +12
  const tAtk = T.filter(isAttacker).length;
  if (T.length === 4 && tAtk < 2 && isAttacker(c)) roleFill += 12;

  // Speed mode synergy
  let speedModeSynergy = 0;
  let mode: 'TR' | 'TW' | 'FAST' = 'FAST';
  if (T.length >= 2) {
    if (T.some(isTrickRoomSetter) && T.some(x => isSlowAttacker(x, pool))) mode = 'TR';
    else if (T.some(isTailwindSetter)) mode = 'TW';
    else mode = 'FAST';
  }

  const twGain = Math.min(12, 6 * countTwPairs(teamPlusC, pool)) - Math.min(12, 6 * countTwPairs(T, pool));
  const trGain = Math.min(12, 6 * countTrPairs(teamPlusC, pool)) - Math.min(12, 6 * countTrPairs(T, pool));

  if (T.length < 2) {
    speedModeSynergy += twGain + trGain;
  } else if (mode === 'TW') {
    speedModeSynergy += twGain;
  } else if (mode === 'TR') {
    speedModeSynergy += trGain;
    if (isFastNonSupport(c, pool, u)) {
      speedModeSynergy -= 3;
    }
  }

  // Field synergy
  let fieldSynergy = 0;
  const pairGain = countFieldPairs(teamPlusC) - countFieldPairs(T);
  fieldSynergy += 8 * pairGain;
  const wsBefore = countWeatherSetters(T);
  const wsAfter = countWeatherSetters(teamPlusC);
  if (wsAfter >= 2 && wsBefore < 2) {
    fieldSynergy -= 4;
  }

  // Weakness overlap
  let weaknessPenalty = 0;
  let weaknessBonus = 0;
  const candidatesForStab = [...oppTeam, ...available];
  for (const type of ALL_TYPES) {
    let weakCount = 0;
    let resistCount = 0;
    for (const member of teamPlusC) {
      if (isWeakTo(type, member)) weakCount++;
      if (resistsOrImmune(type, member)) resistCount++;
    }
    if (weakCount >= 3 && resistCount <= 1) {
      const stab80Count = candidatesForStab.filter(x => hasStabOfType80(x, type)).length;
      const wt = Math.min(2, 0.5 * stab80Count);
      weaknessPenalty += 6 * wt;
    }
    const tWeakInT = T.filter(x => isWeakTo(type, x)).length;
    if (tWeakInT >= 2 && resistsOrImmune(type, c)) {
      weaknessBonus += 3;
    }
  }
  const weaknessOverlap = weaknessPenalty - weaknessBonus;

  // Coverage: +3 for each opponent card c OHKOs or 2HKOs while outspeeding, when nothing in T does
  let coverage = 0;
  const cIdx = pa.idx.get(c.id)!;
  for (const o of oppTeam) {
    const oIdx = pa.idx.get(o.id)!;
    const cHits = pa.dmg[cIdx][oIdx] >= 100 || (pa.dmg[cIdx][oIdx] >= 50 && speed(c) > speed(o));
    if (cHits) {
      const tHits = T.some(t => {
        const tIdx = pa.idx.get(t.id)!;
        return pa.dmg[tIdx][oIdx] >= 100 || (pa.dmg[tIdx][oIdx] >= 50 && speed(t) > speed(o));
      });
      if (!tHits) coverage += 3;
    }
  }

  return C_c + roleFill + speedModeSynergy + fieldSynergy + coverage - weaknessOverlap;
}

function calculateAllMarginalValues(
  team: Card[],
  oppTeam: Card[],
  available: Card[],
  legalCards: Card[],
  pool: Card[],
  pa: PoolAnalysis,
  scarcity: PoolScarcity,
  C_cache: Map<string, number>,
): Map<string, number> {
  const baseMMap = new Map<string, number>();
  for (const c of legalCards) {
    const b = marginalValueBase(c, team, oppTeam, available, pool, pa, scarcity, C_cache);
    baseMMap.set(c.id, b);
  }

  // Top 3 cards by base M
  const sorted = [...legalCards].sort((a, b) => (baseMMap.get(b.id) ?? 0) - (baseMMap.get(a.id) ?? 0));
  const top3 = new Set(sorted.slice(0, 3).map(x => x.id));

  // ItemCost calculation
  const finalMMap = new Map<string, number>();
  for (const c of legalCards) {
    const baseM = baseMMap.get(c.id)!;
    const sameItemRemaining = legalCards.filter(x => x.id !== c.id && x.item === c.item && top3.has(x.id));
    let itemCost = 0;
    if (sameItemRemaining.length > 0) {
      const bestSameM = Math.max(...sameItemRemaining.map(x => baseMMap.get(x.id)!));
      itemCost = 0.5 * Math.max(0, bestSameM);
    }
    finalMMap.set(c.id, baseM - itemCost);
  }

  return finalMMap;
}

// -------------------------------------------------------------
// TEAM PREVIEW: Bring-4 & Leads
// -------------------------------------------------------------
function enumerateSubsets4<T>(arr: T[]): T[][] {
  const out: T[][] = [];
  const n = arr.length;
  for (let a = 0; a < n; a++) {
    for (let b = a + 1; b < n; b++) {
      for (let c = b + 1; c < n; c++) {
        for (let d = c + 1; d < n; d++) {
          out.push([arr[a], arr[b], arr[c], arr[d]]);
        }
      }
    }
  }
  return out;
}

function ans(s: Card, o: Card, pa: PoolAnalysis): number {
  const sIdx = pa.idx.get(s.id)!;
  const oIdx = pa.idx.get(o.id)!;
  const base = pa.win[sIdx][oIdx];
  const ohko = pa.dmg[sIdx][oIdx] >= 100 ? 0.5 : 0;
  const outspeeds = speed(s) > speed(o) ? 0.3 : 0;
  return base + ohko + outspeeds;
}

function evaluateBring4(
  S: Card[],
  targetTeam: Card[],
  pa: PoolAnalysis,
  C_cache: Map<string, number>,
): number {
  // BringScore(S) = Σ over opponent's cards of [weight(o) × max over s in S of Ans(s,o)] + RoleBonus − WeaknessOverlap
  let sumAns = 0;
  for (const o of targetTeam) {
    const oWeight = (C_cache.get(o.id) ?? (40 * pa.power[pa.idx.get(o.id)!] + 30)) / 3;
    let maxA = -Infinity;
    let sumA = 0;
    for (const s of S) {
      const a = ans(s, o, pa);
      if (a > maxA) maxA = a;
      sumA += a;
    }
    const meanA = sumA / S.length;
    sumAns += oWeight * (0.75 * maxA + 0.25 * meanA);
  }

  // RoleBonus: +15 speed control, +8 Fake Out, +8 Intimidate, +5 redirection
  let roleBonus = 0;
  if (S.some(isSpeedControl)) roleBonus += 15;
  if (S.some(x => hasMove(x, 'Fake Out'))) roleBonus += 8;
  if (S.some(x => x.ability === 'Intimidate')) roleBonus += 8;
  if (S.some(x => hasMove(x, 'Follow Me', 'Rage Powder'))) roleBonus += 5;

  // WeaknessOverlap
  let weaknessPenalty = 0;
  for (const type of ALL_TYPES) {
    let weak = 0;
    let resist = 0;
    for (const s of S) {
      if (isWeakTo(type, s)) weak++;
      if (resistsOrImmune(type, s)) resist++;
    }
    if (weak >= 3 && resist <= 1) {
      const stabCount = targetTeam.filter(o => hasStabOfType80(o, type)).length;
      weaknessPenalty += 6 * Math.min(2, 0.5 * stabCount);
    }
  }

  return sumAns + roleBonus - weaknessPenalty;
}

// -------------------------------------------------------------
// BATTLE ENGINE: Priority-based decision maker
// -------------------------------------------------------------
interface FoePrediction {
  foe: MonState;
  move: string;
  targetSlot: number; // 0 or 1
  avgPct: number;
  isFakeOut: boolean;
}

function calcBattleDamage(
  att: MonState,
  def: MonState,
  moveName: string,
  fieldWeather: string,
  fieldTerrain: string,
  singleTarget: boolean,
) {
  if (!att.card || !def.card) return null;
  return moveDamage(att.card, def.card, moveName, {
    atkBoosts: att.boosts,
    defBoosts: def.boosts,
    atkStatus: att.status,
    defStatus: def.status,
    atkHpPct: att.hpPct,
    defHpPct: def.hpPct,
    singleTarget,
    weather: fieldWeather,
    terrain: fieldTerrain,
  });
}

function isFakeOutImmune(target: MonState, targetAlly?: MonState, terrain?: string): boolean {
  if (target.fainted) return true;
  if (!target.card) return false;
  const types = Dex.species.get(target.card.species).types;
  if (types.includes('Ghost')) return true;
  if (target.card.ability === 'Inner Focus') return true;
  if (target.card.item === 'Covert Cloak') return true;
  if (target.card.ability === 'Armor Tail' || target.card.ability === 'Queenly Majesty' || target.card.ability === 'Dazzling') return true;
  if (targetAlly?.card) {
    const allyAb = targetAlly.card.ability;
    if (allyAb === 'Armor Tail' || allyAb === 'Queenly Majesty' || allyAb === 'Dazzling') return true;
  }
  if (terrain === 'Psychic' && !types.includes('Flying') && target.card.ability !== 'Levitate' && target.card.item !== 'Air Balloon') {
    return true;
  }
  return false;
}

function predictFoeActions(
  foes: (MonState | undefined)[],
  myActive: (MonState | undefined)[],
  fieldWeather: string,
  fieldTerrain: string,
): FoePrediction[] {
  const preds: FoePrediction[] = [];
  const aliveMyCount = myActive.filter(m => m && !m.fainted).length;
  const singleTargetForFoe = aliveMyCount <= 1;

  for (let fSlot = 0; fSlot < 2; fSlot++) {
    const f = foes[fSlot];
    if (!f || f.fainted || !f.card) continue;

    // Fake Out on first turn if it has it
    if (f.turnsOnField <= 1 && hasMove(f.card, 'Fake Out')) {
      let bestTgtSlot = -1;
      let maxFoDmg = -1;
      for (let mSlot = 0; mSlot < 2; mSlot++) {
        const m = myActive[mSlot];
        if (!m || m.fainted || !m.card) continue;
        const mAlly = myActive[1 - mSlot];
        if (isFakeOutImmune(m, mAlly, fieldTerrain)) continue;
        const dmg = calcBattleDamage(f, m, 'Fake Out', fieldWeather, fieldTerrain, singleTargetForFoe);
        const d = dmg?.avgPct ?? 0;
        if (d > maxFoDmg) {
          maxFoDmg = d;
          bestTgtSlot = mSlot;
        }
      }
      if (bestTgtSlot >= 0) {
        preds.push({
          foe: f,
          move: 'Fake Out',
          targetSlot: bestTgtSlot,
          avgPct: Math.max(0, maxFoDmg),
          isFakeOut: true,
        });
        continue;
      }
    }

    // Otherwise: highest-damage move into the target it damages most
    let bestMove = f.card.moves[0];
    let bestTgtSlot = 0;
    let maxDmg = -1;

    for (const mv of f.card.moves) {
      const dm = Dex.moves.get(mv);
      if (!dm.exists || dm.category === 'Status') continue;
      for (let mSlot = 0; mSlot < 2; mSlot++) {
        const m = myActive[mSlot];
        if (!m || m.fainted || !m.card) continue;
        const dmg = calcBattleDamage(f, m, mv, fieldWeather, fieldTerrain, singleTargetForFoe);
        if (dmg && dmg.avgPct > maxDmg) {
          maxDmg = dmg.avgPct;
          bestMove = mv;
          bestTgtSlot = mSlot;
        }
      }
    }

    const bestDm = Dex.moves.get(bestMove);
    if (bestDm.exists && (bestDm.target === 'allAdjacentFoes' || bestDm.target === 'allAdjacent')) {
      for (let mSlot = 0; mSlot < 2; mSlot++) {
        const m = myActive[mSlot];
        if (!m || m.fainted || !m.card) continue;
        const dmg = calcBattleDamage(f, m, bestMove, fieldWeather, fieldTerrain, singleTargetForFoe);
        preds.push({
          foe: f,
          move: bestMove,
          targetSlot: mSlot,
          avgPct: Math.max(0, dmg?.avgPct ?? 0),
          isFakeOut: false,
        });
      }
    } else {
      preds.push({
        foe: f,
        move: bestMove,
        targetSlot: bestTgtSlot,
        avgPct: Math.max(0, maxDmg),
        isFakeOut: false,
      });
    }
  }

  // Retargeting adjustment for single-target attacks:
  // If both foes single-target the same slot and one already KOs it, the other retargets to the other slot
  if (preds.length === 2 && preds[0].foe !== preds[1].foe && preds[0].targetSlot === preds[1].targetSlot) {
    const sharedSlot = preds[0].targetSlot;
    const otherSlot = 1 - sharedSlot;
    const otherMon = myActive[otherSlot];

    if (otherMon && !otherMon.fainted && otherMon.card) {
      const ko0 = preds[0].avgPct >= (myActive[sharedSlot]?.hpPct ?? 100);
      const ko1 = preds[1].avgPct >= (myActive[sharedSlot]?.hpPct ?? 100);

      if (ko0 || ko1) {
        const retargetIdx = ko0 ? 1 : 0;
        const rf = preds[retargetIdx].foe;
        let rMove = rf.card!.moves[0];
        let rMax = -1;
        for (const mv of rf.card!.moves) {
          const dm = Dex.moves.get(mv);
          if (!dm.exists || dm.category === 'Status') continue;
          const dmg = calcBattleDamage(rf, otherMon, mv, fieldWeather, fieldTerrain, singleTargetForFoe);
          if (dmg && dmg.avgPct > rMax) {
            rMax = dmg.avgPct;
            rMove = mv;
          }
        }
        preds[retargetIdx].targetSlot = otherSlot;
        preds[retargetIdx].move = rMove;
        preds[retargetIdx].avgPct = Math.max(0, rMax);
      }
    }
  }

  return preds;
}

function calculateSpeedInBattle(m: MonState, field: BattleView['state']['field'], side: 'me' | 'opp' = 'me'): number {
  if (!m.card) return 100;
  let sp = speed(m.card);
  // Boost stages
  const b = m.boosts.spe ?? 0;
  if (b > 0) sp = Math.floor(sp * (2 + b) / 2);
  else if (b < 0) sp = Math.floor(sp * 2 / (2 - b));

  // Paralysis
  if (m.status === 'par') sp = Math.floor(sp * 0.5);

  // Tailwind
  if (side === 'me' && field.tailwind.me > 0) sp *= 2;
  if (side === 'opp' && field.tailwind.opp > 0) sp *= 2;

  // Weather speed abilities
  const w = field.weather;
  if (m.card.ability === 'Swift Swim' && (w === 'RainDance' || w === 'PrimordialSea')) sp *= 2;
  if (m.card.ability === 'Chlorophyll' && (w === 'SunnyDay' || w === 'DesolateLand')) sp *= 2;
  if (m.card.ability === 'Sand Rush' && w === 'Sandstorm') sp *= 2;
  if (m.card.ability === 'Slush Rush' && w === 'Snowscape') sp *= 2;

  return sp;
}

// -------------------------------------------------------------
// BOT FACTORY
// -------------------------------------------------------------
export default (): Bot => {
  let pa: PoolAnalysis | null = null;
  let scarcity: PoolScarcity | null = null;
  const C_cache = new Map<string, number>();
  let nextB2BPick: string | null = null;

  // Battle state tracking across turns
  const switchedLastTurn = [false, false];
  let lastTurnNumber = -1;

  return {
    name: 'gemini2/field',

    // =========================================================
    // DRAFT
    // =========================================================
    draftPick: (v: DraftView) => {
      if (!pa || pa.cards !== v.pool) {
        pa = analyzePool(v.pool);
        scarcity = computeScarcity(v.pool, pa);
        C_cache.clear();
        nextB2BPick = null;
        for (const c of v.pool) {
          C_cache.set(c.id, cardScore(c, v.pool, pa, scarcity));
        }
      }

      const p = pa;
      const sc = scarcity!;
      const me = v.me;
      const opp: Side = me === 'A' ? 'B' : 'A';
      const myTeam = v.picks[me];
      const oppTeam = v.picks[opp];

      // Pick 1: highest C
      if (myTeam.length === 0) {
        let best = v.legal[0];
        let bestC = C_cache.get(best.id) ?? -Infinity;
        for (const c of v.legal) {
          const val = C_cache.get(c.id) ?? -Infinity;
          if (val > bestC) {
            bestC = val;
            best = c;
          }
        }
        return best.id;
      }

      // Back-to-back picks: choose best pair jointly (M(a) + M(b | a))
      const isBackToBackFirst = v.order[v.pickIndex] === me &&
        v.pickIndex + 1 < v.order.length &&
        v.order[v.pickIndex + 1] === me;

      if (isBackToBackFirst) {
        let bestCardA = v.legal[0];
        let bestCardB = v.legal[0];
        let bestJointM = -Infinity;

        const mMeMap = calculateAllMarginalValues(myTeam, oppTeam, v.available, v.legal, v.pool, p, sc, C_cache);

        for (const a of v.legal) {
          const ma = mMeMap.get(a.id) ?? 0;
          const availAfterA = v.available.filter(x => x.id !== a.id);
          const itemsA = new Set([...myTeam.map(x => x.item), a.item]);
          const legalB = availAfterA.filter(x => !itemsA.has(x.item));
          const candB = legalB.length ? legalB : availAfterA;

          const mBMap = calculateAllMarginalValues([...myTeam, a], oppTeam, availAfterA, candB, v.pool, p, sc, C_cache);
          let bestMb = -Infinity;
          let bestBForA = candB[0];
          for (const b of candB) {
            const mb = mBMap.get(b.id) ?? 0;
            if (mb > bestMb) {
              bestMb = mb;
              bestBForA = b;
            }
          }

          const joint = ma + (bestMb > -Infinity ? bestMb : 0);
          if (joint > bestJointM) {
            bestJointM = joint;
            bestCardA = a;
            bestCardB = bestBForA;
          }
        }
        nextB2BPick = bestCardB.id;
        return bestCardA.id;
      }

      if (nextB2BPick) {
        const id = nextB2BPick;
        nextB2BPick = null;
        if (v.legal.some(x => x.id === id)) {
          return id;
        }
      }

      // Normal pick: PickScore = M_me(c) + λ * Deny(c) + κ * Counter(c)
      const mMeMap = calculateAllMarginalValues(myTeam, oppTeam, v.available, v.legal, v.pool, p, sc, C_cache);

      const mOppMap = v.oppLegal.length > 0 ?
        calculateAllMarginalValues(oppTeam, myTeam, v.available, v.oppLegal, v.pool, p, sc, C_cache) :
        new Map<string, number>();

      const oppLegalSorted = [...v.oppLegal].sort((a, b) => (mOppMap.get(b.id) ?? 0) - (mOppMap.get(a.id) ?? 0));

      // Calculate k: how many picks opp makes before my next pick
      let k = 0;
      let idx = v.pickIndex + 1;
      while (idx < v.order.length && v.order[idx] === me) {
        idx++;
      }
      while (idx < v.order.length && v.order[idx] === opp) {
        k++;
        idx++;
      }

      const oppTopKIds = new Set(oppLegalSorted.slice(0, Math.max(1, k)).map(x => x.id));
      const oppPicksLeft = oppTeam.length < 6 && k > 0;

      // λ calculation
      const calcLambda = (c: Card): number => {
        if (!oppPicksLeft) return 0;
        const oppVal = mOppMap.get(c.id) ?? 0;
        const nextBestOpp = oppLegalSorted.find(x => x.id !== c.id);
        const nextVal = nextBestOpp ? (mOppMap.get(nextBestOpp.id) ?? 0) : 0;
        if (oppVal - nextVal >= 15) return 0.8;
        return 0.5;
      };

      // Counter(c): number of opponent cards c beats 1v1 that T has no answer for
      const isLastPick = myTeam.length === 5;
      const kappa = isLastPick ? 5 : 3;

      const calcCounter = (c: Card): number => {
        const cIdx = p.idx.get(c.id)!;
        let cnt = 0;
        for (const o of oppTeam) {
          const oIdx = p.idx.get(o.id)!;
          const tHasAnswer = myTeam.some(t => p.win[p.idx.get(t.id)!][oIdx] > 0.5);
          if (!tHasAnswer && p.win[cIdx][oIdx] > 0.5) {
            cnt++;
          }
        }
        return cnt;
      };

      const pickScores = new Map<string, number>();
      for (const c of v.legal) {
        const mMe = mMeMap.get(c.id) ?? 0;
        let deny = 0;
        if (v.oppLegal.some(x => x.id === c.id) && oppTopKIds.has(c.id)) {
          deny = mOppMap.get(c.id) ?? 0;
        }
        const lam = calcLambda(c);
        const counter = calcCounter(c);
        const score = mMe + lam * deny + kappa * counter;
        pickScores.set(c.id, score);
      }

      const sortedByPickScore = [...v.legal].sort((a, b) => (pickScores.get(b.id) ?? 0) - (pickScores.get(a.id) ?? 0));
      const topCard = sortedByPickScore[0];

      // Item Clause override:
      // "if my top card is illegal for the opponent and the best contested card is within 10 of it, take the contested card first."
      const isTopIllegalForOpp = !v.oppLegal.some(x => x.id === topCard.id);
      if (isTopIllegalForOpp) {
        const contested = v.legal.filter(c => v.oppLegal.some(x => x.id === c.id));
        if (contested.length > 0) {
          const bestContested = contested.sort((a, b) => (pickScores.get(b.id) ?? 0) - (pickScores.get(a.id) ?? 0))[0];
          const topScore = pickScores.get(topCard.id) ?? 0;
          const contScore = pickScores.get(bestContested.id) ?? 0;
          if (topScore - contScore <= 10) {
            return bestContested.id;
          }
        }
      }

      return topCard.id;
    },

    // =========================================================
    // TEAM PREVIEW
    // =========================================================
    teamPreview: (v: PreviewView): PreviewChoice => {
      const fullPool = [...v.myTeam, ...v.oppTeam];
      const p = analyzePool(fullPool);

      // Compute C scores for preview weighting
      const previewCMap = new Map<string, number>();
      const sc = scarcity ?? computeScarcity(fullPool, p);
      for (const c of fullPool) {
        previewCMap.set(c.id, C_cache.get(c.id) ?? cardScore(c, fullPool, p, sc));
      }

      // 1. Determine opponent's likely 4: mirror scoring from their side
      const oppSubsets = enumerateSubsets4(v.oppTeam);
      let bestOppScore = -Infinity;
      let oppLikely4 = oppSubsets[0];
      for (const sOpp of oppSubsets) {
        const scOpp = evaluateBring4(sOpp, v.myTeam, p, previewCMap);
        if (scOpp > bestOppScore) {
          bestOppScore = scOpp;
          oppLikely4 = sOpp;
        }
      }

      // 2. Check hard rule:
      // "if the opponent has Trick Room plus 2 or more slow attackers, S must include Taunt, Fake Out with a fast attacker, or 2 slow cards."
      const oppHasTR = oppLikely4.some(isTrickRoomSetter) || v.oppTeam.some(isTrickRoomSetter);
      const oppSlowAtkCount = oppLikely4.filter(x => isSlowAttacker(x, fullPool)).length;
      const mustCounterTR = oppHasTR && oppSlowAtkCount >= 2;

      const mySubsets = enumerateSubsets4(v.myTeam);
      let bestBring = mySubsets[0];
      let bestBringScore = -Infinity;

      for (const S of mySubsets) {
        if (mustCounterTR) {
          const hasTaunt = S.some(x => hasMove(x, 'Taunt'));
          const hasFOAndFast = S.some(x => hasMove(x, 'Fake Out')) && S.some(x => isFastAttacker(x, fullPool));
          const slowCount = S.filter(x => isSlowCard(x, fullPool)).length;
          if (!hasTaunt && !hasFOAndFast && slowCount < 2) {
            continue; // violates hard rule
          }
        }

        const score = evaluateBring4(S, oppLikely4, p, previewCMap);
        if (score > bestBringScore) {
          bestBringScore = score;
          bestBring = S;
        }
      }

      // 3. Leads:
      // "of the 6 pairs in S, prefer a pair containing Fake Out, speed control or Intimidate. Keep the best answer to the opponent's strongest card in the back."
      let oStar = oppLikely4[0];
      let maxOPower = -Infinity;
      for (const o of oppLikely4) {
        const pow = p.power[p.idx.get(o.id)!];
        if (pow > maxOPower) {
          maxOPower = pow;
          oStar = o;
        }
      }

      let sStar = bestBring[0];
      let maxAns = -Infinity;
      for (const s of bestBring) {
        const a = ans(s, oStar, p);
        if (a > maxAns) {
          maxAns = a;
          sStar = s;
        }
      }

      let bestPair = [bestBring[0], bestBring[1]];
      let bestPairScore = -Infinity;

      for (let i = 0; i < 4; i++) {
        for (let j = i + 1; j < 4; j++) {
          const a = bestBring[i];
          const b = bestBring[j];
          let leadScore = 0;

          // Power/ans baseline for the pair so we don't lead frail useless cards
          const powA = p.power[p.idx.get(a.id)!];
          const powB = p.power[p.idx.get(b.id)!];
          leadScore += (powA + powB) * 15;

          // Keep best answer in back
          if (a.id !== sStar.id && b.id !== sStar.id) leadScore += 50;

          // Fake Out in lead
          if (hasMove(a, 'Fake Out') || hasMove(b, 'Fake Out')) leadScore += 20;

          // Speed control in lead
          if (isSpeedControl(a) || isSpeedControl(b)) leadScore += 15;

          // Intimidate in lead
          if (a.ability === 'Intimidate' || b.ability === 'Intimidate') leadScore += 10;

          if (leadScore > bestPairScore) {
            bestPairScore = leadScore;
            bestPair = [a, b];
          }
        }
      }

      const back = bestBring.filter(x => x.id !== bestPair[0].id && x.id !== bestPair[1].id);
      const chosen4 = [bestPair[0], bestPair[1], back[0], back[1]];
      const order = chosen4.map(c => v.myTeam.findIndex(t => t.id === c.id));

      return { order };
    },

    // =========================================================
    // BATTLE
    // =========================================================
    chooseAction: (v: BattleView): string => {
      const req = v.request;
      const opts = slotOptions(req);
      const field = v.state.field;

      if (field.turn !== lastTurnNumber) {
        lastTurnNumber = field.turn;
      }

      // Forced switch
      if (req.forceSwitch) {
        const foes = [0, 1].map(s => v.state.opp.find(m => m.active && m.slot === s && !m.fainted));
        const benchCards = req.side.pokemon
          .map((p: any, i: number) => ({ p, i: i + 1, card: v.myTeam.find(c => c.species === p.details.split(',')[0]) }))
          .filter(({ p }: any) => !p.active && !p.condition.endsWith(' fnt') && p.condition !== '0 fnt');

        const scoreBench = (bCard: Card | undefined) => {
          if (!bCard) return 0;
          let s = 0;
          for (const f of foes) {
            if (f?.card) s += oneVsOne(bCard, f.card);
          }
          return s;
        };

        let bestJoint = jointChoices(opts)[0];
        let bestScore = -Infinity;

        for (const j of jointChoices(opts)) {
          let score = 0;
          for (const part of j.parts) {
            if (part.kind === 'switch' && part.switchTo) {
              const b = benchCards.find(x => x.i === part.switchTo);
              score += scoreBench(b?.card);
            }
          }
          if (score > bestScore) {
            bestScore = score;
            bestJoint = j;
          }
        }
        return bestJoint.choice;
      }

      const myActive = [0, 1].map(s => v.state.my.find(m => m.active && m.slot === s && !m.fainted));
      const foes = [0, 1].map(s => v.state.opp.find(m => m.active && m.slot === s && !m.fainted));

      // Opponent prediction
      const foePreds = predictFoeActions(foes, myActive, field.weather, field.terrain);
      const incomingDmg = [0, 0];
      const targetedCount = [0, 0];
      for (const p of foePreds) {
        incomingDmg[p.targetSlot] += p.avgPct;
        targetedCount[p.targetSlot]++;
      }

      // Update switchedLastTurn state from tracker's turnsOnField
      for (let s = 0; s < 2; s++) {
        const mon = myActive[s];
        switchedLastTurn[s] = !!mon && mon.turnsOnField <= 1;
      }

      // Check switching per slot:
      // "switch a slot out if it's predicted to be KO'd, can't Protect, and a bench card takes 40% or less from the predicted attacks. Never switch the same slot twice in a row."
      const shouldSwitchSlot = [false, false];
      const switchTargetSlot = [-1, -1];

      const benchCards = req.side.pokemon
        .map((p: any, i: number) => ({ p, i: i + 1, card: v.myTeam.find(c => c.species === p.details.split(',')[0]) }))
        .filter(({ p }: any) => !p.active && !p.condition.endsWith(' fnt') && p.condition !== '0 fnt');

      for (let s = 0; s < 2; s++) {
        const mon = myActive[s];
        if (!mon || mon.fainted || !mon.card) continue;

        const isPredictedKO = incomingDmg[s] >= mon.hpPct;
        const canProtect = hasProtect(mon.card) && !mon.protectedLastTurn;
        const switchedRecently = switchedLastTurn[s];

        if (isPredictedKO && !canProtect && !switchedRecently) {
          const attacksOnSlot = foePreds.filter(p => p.targetSlot === s);
          let bestBenchChoice = -1;
          let minDmgTaken = Infinity;

          for (const b of benchCards) {
            if (!b.card) continue;
            let dmgOnBench = 0;
            for (const att of attacksOnSlot) {
              const d = moveDamage(att.foe.card!, b.card, att.move, {
                atkBoosts: att.foe.boosts, defBoosts: {}, weather: field.weather, terrain: field.terrain,
              });
              dmgOnBench += d?.avgPct ?? 0;
            }
            if (dmgOnBench <= 40 && dmgOnBench < minDmgTaken) {
              minDmgTaken = dmgOnBench;
              bestBenchChoice = b.i;
            }
          }

          if (bestBenchChoice > 0) {
            shouldSwitchSlot[s] = true;
            switchTargetSlot[s] = bestBenchChoice;
          }
        }
      }

      // Priority 0: Filter self-harm for an option
      const isLegalAndSafe = (slot: number, o: SlotOption): boolean => {
        if (o.kind === 'pass') return true;
        if (o.kind === 'switch') return true;
        const me = myActive[slot];
        if (!me?.card || !o.move) return true;
        const dm = Dex.moves.get(o.move);

        // Never a damaging move into my own ally
        if (o.target && o.target < 0 && dm.category !== 'Status') {
          return false;
        }

        // No ally-hitting spread move unless ally is immune or takes under 25% without fainting
        const ally = myActive[1 - slot];
        if (dm.target === 'allAdjacent' && ally?.card && !ally.fainted) {
          const dAlly = moveDamage(me.card, ally.card, o.move, {
            atkBoosts: me.boosts, defBoosts: ally.boosts, weather: field.weather, terrain: field.terrain,
          });
          const takesUnder25 = dAlly && dAlly.maxPct < 25 && ally.hpPct > dAlly.maxPct;
          const isImmune = !dAlly || dAlly.maxPct === 0;
          if (!isImmune && !takesUnder25) return false;
        }

        // Target check
        const targetMon = o.target && o.target > 0 ? foes[o.target - 1] : undefined;

        // No Ground moves into Flying or Levitate
        if (dm.type === 'Ground' && targetMon?.card) {
          const tTypes = Dex.species.get(targetMon.card.species).types;
          if (tTypes.includes('Flying') || targetMon.card.ability === 'Levitate' || targetMon.card.item === 'Air Balloon') {
            return false;
          }
        }

        // No status moves into immunity
        if (dm.category === 'Status' && targetMon?.card) {
          const tTypes = Dex.species.get(targetMon.card.species).types;
          if (dm.name === 'Thunder Wave' && tTypes.includes('Ground')) return false;
          if (['Spore', 'Sleep Powder'].includes(dm.name) && (tTypes.includes('Grass') || targetMon.card.item === 'Safety Goggles' || targetMon.card.ability === 'Overcoat')) return false;
          if (dm.name === 'Will-O-Wisp' && tTypes.includes('Fire')) return false;
          if (targetMon.card.ability === 'Good as Gold') return false;
          if (me.card.ability === 'Prankster' && tTypes.includes('Dark')) return false;
        }

        // No Fake Out unless turnsOnField <= 1
        if (o.move === 'Fake Out' && me.turnsOnField > 1) {
          return false;
        }

        // No Trick Room while Trick Room is active
        if (o.move === 'Trick Room' && field.trickRoom > 0) {
          return false;
        }

        // No Tailwind while my Tailwind is active
        if (o.move === 'Tailwind' && field.tailwind.me > 0) {
          return false;
        }

        return true;
      };

      const aliveFoesCount = foes.filter(f => f && !f.fainted).length;
      const singleTargetForMe = aliveFoesCount <= 1;
      const aliveMyCount = myActive.filter(m => m && !m.fainted).length;
      const singleTargetForFoe = aliveMyCount <= 1;

      // Foe threat calculation:
      // "Focus fire on the target with the highest threat (most damage it can deal to my side, × 1.3 if it outspeeds)"
      const foeThreat = (f: MonState | undefined): number => {
        if (!f || f.fainted || !f.card) return -1;
        let maxDmg = 0;
        let outspeedsAny = false;
        const fSpeed = calculateSpeedInBattle(f, field, 'opp');

        for (const m of myActive) {
          if (!m || m.fainted || !m.card) continue;
          const mSpeed = calculateSpeedInBattle(m, field, 'me');
          if (fSpeed > mSpeed) outspeedsAny = true;
          for (const mv of f.card.moves) {
            const d = calcBattleDamage(f, m, mv, field.weather, field.terrain, singleTargetForFoe);
            if (d && d.avgPct > maxDmg) maxDmg = d.avgPct;
          }
        }
        return maxDmg * (outspeedsAny ? 1.3 : 1.0);
      };

      const threat0 = foeThreat(foes[0]);
      const threat1 = foeThreat(foes[1]);
      const topThreatFoeSlot = threat0 >= threat1 ? 0 : 1;
      const topThreatFoe = foes[topThreatFoeSlot];

      // Helper to check priority and speed order between two pokemon and their moves
      const movesBefore = (monA: MonState, moveA: string, sideA: 'me' | 'opp', monB: MonState, moveB: string, sideB: 'me' | 'opp'): boolean => {
        if (!monA.card || !monB.card) return true;
        const dmA = Dex.moves.get(moveA);
        const dmB = Dex.moves.get(moveB);
        let pA = dmA.priority;
        let pB = dmB.priority;
        if (monA.card.ability === 'Prankster' && dmA.category === 'Status') pA += 1;
        if (monB.card.ability === 'Prankster' && dmB.category === 'Status') pB += 1;
        if (pA !== pB) return pA > pB;
        const sA = calculateSpeedInBattle(monA, field, sideA);
        const sB = calculateSpeedInBattle(monB, field, sideB);
        return field.trickRoom > 0 ? sA < sB : sA > sB;
      };

      // Speed control flip check: flips 2 or more speed matchups and setter survives
      const flipsSpeedMatchups = (move: string): boolean => {
        let flipped = 0;
        let worsened = 0;
        for (const myM of myActive) {
          if (!myM || myM.fainted || !myM.card) continue;
          const mySpd = calculateSpeedInBattle(myM, field, 'me');
          for (const f of foes) {
            if (!f || f.fainted || !f.card) continue;
            const fSpd = calculateSpeedInBattle(f, field, 'opp');
            const currentlyFoeFaster = fSpd > mySpd;

            let afterMySpd = mySpd;
            let afterFSpd = fSpd;
            if (move === 'Tailwind') afterMySpd *= 2;
            else if (move === 'Icy Wind' || move === 'Electroweb') afterFSpd = Math.floor(afterFSpd * 2 / 3);

            let afterMeFaster = afterMySpd > afterFSpd;
            if (move === 'Trick Room' || field.trickRoom > 0) {
              afterMeFaster = afterMySpd < afterFSpd;
            }

            if (currentlyFoeFaster && afterMeFaster) flipped++;
            if (!currentlyFoeFaster && !afterMeFaster) worsened++;
          }
        }
        return (flipped - worsened) >= 2;
      };

      // Check if setter survives the turn (and is not KO'd before moving)
      const setterSurvivesTurn = (setter: MonState, slot: number, move: string): boolean => {
        if (incomingDmg[slot] >= setter.hpPct) return false;
        let lethalDmgBeforeSetter = 0;
        for (const pred of foePreds) {
          if (pred.targetSlot !== slot) continue;
          const foeFaster = movesBefore(pred.foe, pred.move, 'opp', setter, move, 'me');
          if (foeFaster) {
            lethalDmgBeforeSetter += pred.avgPct;
          }
        }
        return lethalDmgBeforeSetter < setter.hpPct;
      };

      // Best single-target damage for spread comparison
      const bestSingleTargetDmg = (me: MonState): number => {
        let best = 0;
        if (!me.card) return 0;
        for (const mv of me.card.moves) {
          const dm = Dex.moves.get(mv);
          if (!dm.exists || dm.category === 'Status') continue;
          if (dm.target === 'allAdjacentFoes' || dm.target === 'allAdjacent') continue;
          for (const f of foes) {
            if (!f?.card || f.fainted) continue;
            const d = calcBattleDamage(me, f, mv, field.weather, field.terrain, singleTargetForMe);
            if (d) {
              const eff = Math.min(f.hpPct, d.avgPct);
              if (eff > best) best = eff;
            }
          }
        }
        return best;
      };

      interface EvaluatedOption {
        option: SlotOption;
        tier: number; // 1 = Secure KO, 2 = Fake Out, 3 = Speed control, 4 = Protect, 5 = Spread, 6 = Focus fire, 7 = Highest damage
        score: number;
        targetFoeSlot?: number;
        minRollKO?: boolean;
        avgDmg: number;
      }

      const evalSlotOption = (slot: number, o: SlotOption): EvaluatedOption => {
        const me = myActive[slot];
        if (o.kind === 'pass') return { option: o, tier: 8, score: 0, avgDmg: 0 };
        if (o.kind === 'switch') {
          if (shouldSwitchSlot[slot] && o.switchTo === switchTargetSlot[slot]) {
            return { option: o, tier: 4, score: 5000, avgDmg: 0 };
          }
          return { option: o, tier: 8, score: -100, avgDmg: 0 };
        }

        if (!me?.card || !o.move) return { option: o, tier: 7, score: 1, avgDmg: 0 };
        const dm = Dex.moves.get(o.move);

        // Priority 1: Secure KO: minimum roll >= target's HP, and I move first or survive its hit
        if (dm.category !== 'Status') {
          if (o.target && o.target > 0) {
            const tgt = foes[o.target - 1];
            if (tgt?.card && !tgt.fainted) {
              const d = calcBattleDamage(me, tgt, o.move, field.weather, field.terrain, singleTargetForMe);
              if (d && d.minPct >= tgt.hpPct) {
                const foeMove = foePreds.find(p => p.foe === tgt)?.move ?? tgt.card.moves[0];
                const moveFirst = movesBefore(me, o.move, 'me', tgt, foeMove, 'opp');
                const survivesHit = incomingDmg[slot] < me.hpPct;
                if (moveFirst || survivesHit) {
                  return {
                    option: o,
                    tier: 1,
                    score: 10000 + (moveFirst ? 500 : 0) + Math.min(tgt.hpPct, d.avgPct),
                    targetFoeSlot: o.target - 1,
                    minRollKO: true,
                    avgDmg: d.avgPct,
                  };
                }
              }
            }
          } else if (dm.target === 'allAdjacentFoes' || dm.target === 'allAdjacent') {
            for (let fSlot = 0; fSlot < 2; fSlot++) {
              const tgt = foes[fSlot];
              if (!tgt?.card || tgt.fainted) continue;
              const d = calcBattleDamage(me, tgt, o.move, field.weather, field.terrain, singleTargetForMe);
              if (d && d.minPct >= tgt.hpPct) {
                const foeMove = foePreds.find(p => p.foe === tgt)?.move ?? tgt.card.moves[0];
                const moveFirst = movesBefore(me, o.move, 'me', tgt, foeMove, 'opp');
                const survivesHit = incomingDmg[slot] < me.hpPct;
                if (moveFirst || survivesHit) {
                  return {
                    option: o,
                    tier: 1,
                    score: 10000 + (moveFirst ? 500 : 0) + Math.min(tgt.hpPct, d.avgPct),
                    targetFoeSlot: fSlot,
                    minRollKO: true,
                    avgDmg: d.avgPct,
                  };
                }
              }
            }
          }
        }

        // Priority 2: Fake Out into biggest threat
        if (o.move === 'Fake Out' && me.turnsOnField <= 1) {
          const tgt = o.target && o.target > 0 ? foes[o.target - 1] : undefined;
          const tgtAlly = o.target && o.target > 0 ? foes[2 - o.target] : undefined;
          if (tgt && tgt === topThreatFoe && !isFakeOutImmune(tgt, tgtAlly, field.terrain)) {
            return { option: o, tier: 2, score: 8500, avgDmg: 10, targetFoeSlot: topThreatFoeSlot };
          }
          if (tgt && !isFakeOutImmune(tgt, tgtAlly, field.terrain)) {
            return { option: o, tier: 2, score: 8000, avgDmg: 10, targetFoeSlot: o.target! - 1 };
          }
        }

        // Priority 3: Speed control if flips >= 2 speed matchups and setter survives
        if (['Tailwind', 'Trick Room', 'Icy Wind', 'Electroweb'].includes(o.move)) {
          const setterSurvives = setterSurvivesTurn(me, slot, o.move);
          if (setterSurvives && flipsSpeedMatchups(o.move)) {
            return { option: o, tier: 3, score: 7500, avgDmg: 5 };
          }
        }

        // Priority 4: Protect slot if incoming damage >= HP or double-targeted, and did not Protect last turn
        if (o.move === 'Protect' || o.move === 'Detect' || o.move === 'Spiky Shield' || o.move === 'Baneful Bunker') {
          if (me.protectedLastTurn) return { option: o, tier: 8, score: -500, avgDmg: 0 };
          const needProtect = incomingDmg[slot] >= me.hpPct || targetedCount[slot] >= 2;
          if (needProtect) {
            return { option: o, tier: 4, score: 6500, avgDmg: 0 };
          }
          return { option: o, tier: 7, score: 2, avgDmg: 0 };
        }

        // Priority 5: Spread move if total damage beats best single-target option
        if (dm.target === 'allAdjacentFoes' || dm.target === 'allAdjacent') {
          let totalSpread = 0;
          for (let fSlot = 0; fSlot < 2; fSlot++) {
            const f = foes[fSlot];
            if (!f?.card || f.fainted) continue;
            const d = calcBattleDamage(me, f, o.move, field.weather, field.terrain, singleTargetForMe);
            if (d) {
              totalSpread += Math.min(f.hpPct, d.avgPct);
            }
          }
          const bestST = bestSingleTargetDmg(me);
          if (totalSpread > bestST) {
            return { option: o, tier: 5, score: 5500 + totalSpread, avgDmg: totalSpread };
          }
        }

        // Priority 6/7: Single target or fallback damaging move
        const tgtSlot = o.target && o.target > 0 ? o.target - 1 : topThreatFoeSlot;
        const tgt = foes[tgtSlot];
        if (tgt?.card && !tgt.fainted && dm.category !== 'Status') {
          const d = calcBattleDamage(me, tgt, o.move, field.weather, field.terrain, singleTargetForMe);
          if (d) {
            const effDmg = Math.min(tgt.hpPct, d.avgPct);
            const isTopThreat = tgt === topThreatFoe;
            return {
              option: o,
              tier: isTopThreat ? 6 : 7,
              score: (isTopThreat ? 1000 : 0) + effDmg,
              targetFoeSlot: tgtSlot,
              minRollKO: false,
              avgDmg: effDmg,
            };
          }
        }

        return { option: o, tier: 7, score: 1, avgDmg: 0 };
      };

      // Joint choice evaluation
      let bestChoice = jointChoices(opts)[0].choice;
      let bestJointScore = -Infinity;

      for (const j of jointChoices(opts)) {
        const safe = j.parts.every((p, s) => isLegalAndSafe(s, p));
        if (!safe) continue;

        const evals = j.parts.map((p, s) => evalSlotOption(s, p));
        let jointScore = 0;

        for (const e of evals) {
          const tierWeight = (8 - e.tier) * 2000;
          jointScore += tierWeight + e.score;
        }

        // Focus Fire coordination:
        // "Both slots hit the same target only if together they KO it and neither does alone. If one slot already KOs it, the other retargets."
        if (
          aliveFoesCount >= 2 &&
          evals.length === 2 &&
          evals[0].targetFoeSlot !== undefined &&
          evals[1].targetFoeSlot !== undefined
        ) {
          const tgt0 = evals[0].targetFoeSlot;
          const tgt1 = evals[1].targetFoeSlot;

          if (tgt0 === tgt1) {
            const target = foes[tgt0];
            const hp = target?.hpPct ?? 100;
            const ko0 = evals[0].minRollKO || evals[0].avgDmg >= hp;
            const ko1 = evals[1].minRollKO || evals[1].avgDmg >= hp;
            const togetherKO = evals[0].avgDmg + evals[1].avgDmg >= hp;

            if (ko0 || ko1) {
              // One slot already KOs it: the other should retarget to the other foe
              jointScore -= 50000;
            } else if (togetherKO) {
              // Together they KO it and neither does alone
              jointScore += 3000;
            } else {
              jointScore -= 500;
            }
          }
        }

        if (jointScore > bestJointScore) {
          bestJointScore = jointScore;
          bestChoice = j.choice;
        }
      }

      return bestChoice;
    },
  };
};
