// Battle engine: builds a payoff table of my joint actions vs predicted opponent joint actions,
// scoring each cell with a deterministic one-turn simulation (turn order, protect, fake out, KOs).
import type { BattleView, Card, MonState } from '../../../src/types';
import { moveDamage, stats, DmgInfo, oneVsOne } from '../../../src/lib/pool';
import { slotOptions, jointChoices, SlotOption } from '../../../src/lib/choices';
import { Dex } from 'pokemon-showdown';

// ---------- tunables ----------
export const P = {
  ALIVE: 35,          // value of a mon being alive beyond its HP
  SPEED_K: 5,         // value per favourable speed pairing next turn
  LAMBDA: 0.7,        // weight of expected value vs worst case
  OPP_TOP_SLOT: 3,    // candidate actions per opposing slot
  OPP_TOP_JOINT: 6,   // opposing joint actions in the table
  OPP_TEMP: 12,       // softmax temperature for opponent prediction
  SCREEN: 10,
  ROLL: 0.8,
  FSIM: 1, DEEP: 1, FILL: 1, ROLL2: 0.5, PRUNE: 20, ROLL3: 0, PARADOX: 1, WORTH: 0, RUIN: 1, FG: 1, SMART: 1, MIX: 0.8, MIX_TOP: 8, ADAPT: 1.2,
  TIE: 0.02,
  EOT: 1, NOSWITCH: 0, NOPROTECT: 0,
  OPP_MINKO: 1, OPP_KO: 50, OPP_FO: 35, OPP_STATUS: 1,
  SCEN: 1, SCEN_W: 0.25, LO: 0.15, HI: 0.85,          // weight of the second (greedy rollout) turn in the evaluation
};

// ---------- small data helpers ----------
const moveCache = new Map<string, any>();
export function mv(name: string): any {
  let m = moveCache.get(name);
  if (!m) { m = Dex.moves.get(name); moveCache.set(name, m); }
  return m;
}
const typeCache = new Map<string, string[]>();
export function typesOf(c: Card): string[] {
  let t = typeCache.get(c.species);
  if (!t) { t = [...Dex.species.get(c.species).types]; typeCache.set(c.species, t); }
  return t;
}
const statCache = new Map<string, any>();
export function st(c: Card) {
  let s = statCache.get(c.id);
  if (!s) { s = stats(c); statCache.set(c.id, s); }
  return s as { hp: number; atk: number; def: number; spa: number; spd: number; spe: number };
}

const PROTECTS = new Set(['Protect', 'Detect', 'Spiky Shield', "King's Shield", 'Baneful Bunker', 'Silk Trap', 'Burning Bulwark', 'Obstruct', 'Max Guard']);
const REDIRECT = new Set(['Follow Me', 'Rage Powder']);
const HEALS = new Set(['Recover', 'Roost', 'Slack Off', 'Soft-Boiled', 'Moonlight', 'Synthesis', 'Morning Sun', 'Shore Up', 'Milk Drink', 'Strength Sap', 'Heal Order', 'Lunar Blessing', 'Jungle Healing']);
const SLEEP = new Set(['Spore', 'Sleep Powder', 'Hypnosis', 'Sing', 'Lovely Kiss', 'Dark Void', 'Grass Whistle']);
const INTIM_IMMUNE = new Set(['Clear Body', 'Hyper Cutter', 'White Smoke', 'Full Metal Body', 'Inner Focus', 'Oblivious', 'Own Tempo', 'Scrappy', 'Guard Dog']);
const PRIO_BLOCK = new Set(['Armor Tail', 'Queenly Majesty', 'Dazzling']);
const STAT_DROP_IMMUNE = new Set(['Clear Body', 'White Smoke', 'Full Metal Body', 'Mirror Armor']);

// ---------- damage cache ----------
const dmgCache = new Map<string, DmgInfo | null>();
function bkey(b: Record<string, number>) {
  let s = '';
  for (const k of ['atk', 'def', 'spa', 'spd', 'spe']) s += (b[k] ?? 0) + ',';
  return s;
}
export function dmg(att: SM, def: SM, move: string, f: SF): DmgInfo | null {
  const defFull = def.hp >= 99.5;
  const fgOn = !!(P.FG && f.fg && f.fg[def.side] && f.fg[def.side] !== def.card.id);
  const multi = def.ability === 'Multiscale' || def.ability === 'Shadow Shield';
  const key = `${att.card.id}|${def.card.id}|${move}|${bkey(att.boosts)}|${bkey(def.boosts)}|${att.status}|${def.status}|${f.weather}|${f.terrain}|${multi && !defFull ? 0 : 1}|${P.RUIN && f.ruin ? f.ruin.join() : ""}|${fgOn}`;
  let d = dmgCache.get(key);
  if (d === undefined) {
    d = moveDamage(att.card, def.card, move, {
      atkBoosts: att.boosts, defBoosts: def.boosts, atkStatus: att.status, defStatus: def.status,
      weather: f.weather, terrain: f.terrain, defHpPct: multi && !defFull ? 50 : undefined,
      ruin: P.RUIN && f.ruin?.length ? f.ruin : undefined, friendGuard: fgOn,
    });
    if (dmgCache.size > 200000) dmgCache.clear();
    dmgCache.set(key, d);
  }
  return d;
}

// ---------- sim types ----------
export interface SM {
  side: 0 | 1; slot: number; card: Card; hp: number; boosts: Record<string, number>; status: string;
  fainted: boolean; protect: boolean; flinch: boolean; acted: boolean; firstTurn: boolean; itemUsed: boolean;
  types: string[]; ability: string; item: string; hh: boolean; protLast: boolean; lastMove?: string;
  physical: boolean; maxHp: number; curMove?: string; charging?: string; chargeTgt?: number; invuln?: boolean;
}
export interface SF {
  tw: [number, number]; tr: number; weather: string; terrain: string;
  screens: [number, number]; redirect: [SM | null, SM | null]; wideGuard: [boolean, boolean];
  ruin?: string[]; fg?: [string, string];
}
export interface Act { kind: 'move' | 'switch' | 'pass'; move?: string; tgt?: number; sw?: SM }
export interface Sim { act: (SM | null)[][]; out: SM[]; inn: SM[]; f: SF; bench?: SM[][] }

function isPhysical(c: Card) {
  let p = 0, s = 0;
  for (const m of c.moves) { const d = mv(m); if (d.category === 'Physical') p += d.basePower || 60; else if (d.category === 'Special') s += d.basePower || 60; }
  return p >= s;
}

export function mkMon(side: 0 | 1, slot: number, card: Card, ms: Partial<MonState>): SM {
  return {
    side, slot, card, hp: ms.hpPct ?? 100, boosts: { ...(ms.boosts ?? {}) } as any, status: ms.status ?? '',
    fainted: !!ms.fainted || (ms.hpPct ?? 100) <= 0, protect: false, flinch: false, acted: false,
    firstTurn: (ms.turnsOnField ?? 0) <= 1, itemUsed: !!ms.itemConsumed, types: typesOf(card),
    ability: card.ability, item: ms.itemConsumed ? '' : card.item, hh: false, protLast: !!ms.protectedLastTurn,
    lastMove: ms.lastMove, physical: isPhysical(card), maxHp: st(card).hp,
  };
}
function cloneMon(m: SM): SM { return { ...m, boosts: { ...m.boosts } }; }
function cloneSim(s: Sim): Sim {
  return {
    act: s.act.map(row => row.map(m => (m ? cloneMon(m) : null))), out: [], inn: [], bench: s.bench,
    f: { ...s.f, tw: [...s.f.tw] as [number, number], screens: [...s.f.screens] as [number, number], redirect: [null, null], wideGuard: [false, false] },
  };
}

// ---------- speed and priority ----------
const speHiCache = new Map<string, boolean>();
function speHighest(c: Card): boolean {
  let v = speHiCache.get(c.id);
  if (v === undefined) { const x = st(c); v = x.spe > Math.max(x.atk, x.def, x.spa, x.spd); speHiCache.set(c.id, v); }
  return v;
}
const stageMult = (n: number) => (n >= 0 ? (2 + n) / 2 : 2 / (2 - n));
export function effSpeed(m: SM, f: SF, twTurns?: number): number {
  let s = st(m.card).spe * stageMult(m.boosts.spe ?? 0);
  if (m.item === 'Choice Scarf') s *= 1.5;
  if (m.item === 'Iron Ball') s *= 0.5;
  const a = m.ability, w = f.weather;
  if ((a === 'Swift Swim' && w === 'RainDance') || (a === 'Chlorophyll' && w === 'SunnyDay') || (a === 'Sand Rush' && w === 'Sandstorm')
    || (a === 'Slush Rush' && (w === 'Snowscape' || w === 'Snow')) || (a === 'Surge Surfer' && f.terrain === 'Electric Terrain')
    || (a === 'Unburden' && m.itemUsed && m.card.item !== '')) s *= 2;
  if (P.PARADOX && (a === 'Protosynthesis' || a === 'Quark Drive') && speHighest(m.card)) {
    const field = a === 'Protosynthesis' ? w === 'SunnyDay' : f.terrain === 'Electric Terrain';
    if (field || m.card.item === 'Booster Energy') s *= 1.5;
  }
  if (a === 'Quick Feet' && m.status) s *= 1.5;
  else if (m.status === 'par') s *= 0.5;
  if ((twTurns ?? f.tw[m.side]) > 0) s *= 2;
  return s;
}
function grounded(m: SM) { return !m.types.includes('Flying') && m.ability !== 'Levitate' && m.item !== 'Air Balloon'; }
export function priorityOf(m: SM, a: Act, f: SF): number {
  if (a.kind === 'switch') return 7;
  if (a.kind !== 'move' || !a.move) return -8;
  const d = mv(a.move);
  let p = d.priority || 0;
  if (m.ability === 'Prankster' && d.category === 'Status') p += 1;
  if (m.ability === 'Gale Wings' && d.type === 'Flying' && m.hp >= 99.5) p += 1;
  if (m.ability === 'Triage' && d.flags?.heal) p += 3;
  if (a.move === 'Grassy Glide' && f.terrain === 'Grassy Terrain') p += 1;
  return p;
}

// ---------- the one-turn simulator ----------
export const LUCK = [0.5, 0.5];
let SCEN: number[][] = [[0.5, 0.5, 1]];
export function setScen() {
  SCEN = P.SCEN ? [[0.5, 0.5, 1 - 2 * P.SCEN_W], [P.LO, P.HI, P.SCEN_W], [P.HI, P.LO, P.SCEN_W]] : [[0.5, 0.5, 1]];
}
function foeOf(s: Sim, m: SM, tgt: number | undefined): SM | null {
  const opp = s.act[1 - m.side];
  if (tgt && tgt > 0) {
    const t = opp[tgt - 1];
    if (t && !t.fainted) return t;
    const o = opp[2 - tgt];
    return o && !o.fainted ? o : null;
  }
  const alive = opp.filter(x => x && !x.fainted) as SM[];
  return alive[0] ?? null;
}

function applyBoosts(t: SM, b: Record<string, number>, fromFoe: boolean) {
  if (fromFoe && (STAT_DROP_IMMUNE.has(t.ability) || t.item === 'Covert Cloak' || t.ability === 'Shield Dust')) return;
  for (const k in b) {
    let v = b[k];
    if (t.ability === 'Contrary') v = -v;
    if (t.ability === 'Simple') v *= 2;
    t.boosts[k] = Math.max(-6, Math.min(6, (t.boosts[k] ?? 0) + v));
    if (fromFoe && v < 0 && (t.ability === 'Defiant')) t.boosts.atk = Math.min(6, (t.boosts.atk ?? 0) + 2);
    if (fromFoe && v < 0 && (t.ability === 'Competitive')) t.boosts.spa = Math.min(6, (t.boosts.spa ?? 0) + 2);
  }
}

function canStatus(t: SM, status: string, f: SF): boolean {
  if (t.fainted || t.status) return false;
  if (t.ability === 'Purifying Salt' || t.ability === 'Comatose') return false;
  if (f.terrain === 'Misty Terrain' && grounded(t)) return false;
  if (status === 'par') return !t.types.includes('Electric') && t.ability !== 'Limber';
  if (status === 'brn') return !t.types.includes('Fire') && t.ability !== 'Water Veil' && t.ability !== 'Water Bubble' && t.ability !== 'Thermal Exchange';
  if (status === 'slp') return !(f.terrain === 'Electric Terrain' && grounded(t)) && !['Insomnia', 'Vital Spirit', 'Sweet Veil'].includes(t.ability);
  if (status === 'tox' || status === 'psn') return !t.types.includes('Steel') && !t.types.includes('Poison') && t.ability !== 'Immunity';
  return true;
}

function doStatusMove(s: Sim, m: SM, a: Act) {
  const name = a.move!;
  const d = mv(name);
  const f = s.f;
  const side = m.side;
  const ally = s.act[side][1 - m.slot];
  if (PROTECTS.has(name)) { if (!m.protLast) m.protect = true; return; }
  if (name === 'Wide Guard') { f.wideGuard[side] = true; return; }
  if (REDIRECT.has(name)) { f.redirect[side] = m; return; }
  if (name === 'Helping Hand') { if (ally && !ally.fainted && !ally.acted) ally.hh = true; return; }
  if (name === 'Tailwind') { if (f.tw[side] <= 0) f.tw[side] = 4; return; }
  if (name === 'Trick Room') { f.tr = f.tr > 0 ? 0 : 5; return; }
  if (name === 'Reflect' || name === 'Light Screen' || name === 'Aurora Veil') {
    if (name !== 'Aurora Veil' || f.weather === 'Snowscape' || f.weather === 'Hail') f.screens[side] += 1;
    return;
  }
  if (HEALS.has(name)) { m.hp = Math.min(100, m.hp + 50); return; }
  if (name === 'Life Dew') { m.hp = Math.min(100, m.hp + 25); if (ally && !ally.fainted) ally.hp = Math.min(100, ally.hp + 25); return; }
  if (name === 'Haze') { for (const row of s.act) for (const x of row) if (x) x.boosts = {}; return; }
  // targeted at a foe
  const foeTarget = d.target === 'normal' || d.target === 'any' || d.target === 'adjacentFoe';
  if (foeTarget) {
    let t = foeOf(s, m, a.tgt);
    const red = f.redirect[1 - side];
    if (red && !red.fainted && red !== t) t = red;
    if (!t || t.fainted) return;
    if (t.protect && d.flags?.protect) return;
    if (m.ability === 'Prankster' && t.types.includes('Dark')) return;
    if (t.ability === 'Good as Gold') return;
    if (d.flags?.powder && (t.types.includes('Grass') || t.ability === 'Overcoat' || t.item === 'Safety Goggles')) return;
    if (d.status && canStatus(t, d.status, f)) {
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
      if (d.status && canStatus(t, d.status, f)) t.status = d.status;
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
    applyBoosts(m, d.boosts, false); if (ally && !ally.fainted) applyBoosts(ally, d.boosts, false);
    return;
  }
  if (d.boosts && d.target === 'adjacentAlly') { if (ally && !ally.fainted) applyBoosts(ally, d.boosts, false); return; }
}

const effCache = new Map<string, boolean>();
function superEff(type: string, types: string[]): boolean {
  const k = type + '|' + types.join(',');
  let v = effCache.get(k);
  if (v === undefined) { v = Dex.getImmunity(type, types) && Dex.getEffectiveness(type, types) > 0; effCache.set(k, v); }
  return v;
}
function endOfTurn(s: Sim) {
  const f = s.f;
  for (const row of s.act) for (const m of row) {
    if (!m || m.fainted) continue;
    const mg = m.ability === 'Magic Guard';
    if (m.item === 'Leftovers' || (m.item === 'Black Sludge' && m.types.includes('Poison'))) m.hp += 6.25;
    if (f.terrain === 'Grassy Terrain' && grounded(m)) m.hp += 6.25;
    if (!mg) {
      if (m.status === 'brn') m.hp -= 6.25;
      if (m.status === 'psn' && m.ability !== 'Poison Heal') m.hp -= 12.5;
      if (m.status === 'tox' && m.ability !== 'Poison Heal') m.hp -= 12.5;
      if (f.weather === 'Sandstorm' && !m.types.some(x => x === 'Rock' || x === 'Ground' || x === 'Steel') && !['Overcoat', 'Sand Veil', 'Sand Rush', 'Sand Force'].includes(m.ability) && m.item !== 'Safety Goggles') m.hp -= 6.25;
    }
    if (m.hp > 100) m.hp = 100;
    if (m.hp <= 0) { m.hp = 0; m.fainted = true; }
  }
}
function hit(s: Sim, m: SM, t: SM, a: Act, d: any, nTargets: number): number {
  if (t.invuln && m.ability !== 'No Guard' && t.ability !== 'No Guard') return 0;
  const f = s.f;
  if (t.protect && d.flags?.protect) return 0;
  if (nTargets > 1 && f.wideGuard[t.side]) return 0;
  if (a.move === 'Sucker Punch' || a.move === 'Thunderclap') {
    // fails if target already moved or is not attacking (approximated by acted flag)
    if (t.acted || (t.curMove && mv(t.curMove).category === 'Status')) return 0;
  }
  if (priorityOf(m, a, f) > 0 && t.side !== m.side && ((f.terrain === 'Psychic Terrain' && grounded(t)) || PRIO_BLOCK.has(t.ability) || PRIO_BLOCK.has(s.act[t.side][1 - t.slot]?.ability ?? ''))) return 0;
  const r = dmg(m, t, a.move!, f);
  if (!r) return 0;
  const L = LUCK[m.side];
  const ERUPT = a.move === 'Eruption' || a.move === 'Water Spout' || a.move === 'Dragon Energy';
  let amt = L === 0.5 ? r.avgPct : (r.rolls?.length ? r.rolls[Math.round(L * (r.rolls.length - 1))] : r.minPct + L * (r.maxPct - r.minPct));
  if (r.spread && nTargets === 1) amt /= 0.75;
  if (ERUPT) amt *= Math.max(0.01, m.hp / 100);
  if (m.hh) amt *= 1.5;
  if (f.screens[t.side] > 0 && t.side !== m.side && a.move !== 'Brick Break' && a.move !== 'Psychic Fangs') amt *= 2 / 3;
  if (d.accuracy !== true && d.accuracy < 100) { if (L === 0.5) amt *= d.accuracy / 100; else if (d.accuracy < 100 * (1 - L) + 1e-9 && L < 0.5) amt = 0; }
  if (amt >= t.hp && t.hp >= 99.5 && ((t.item === 'Focus Sash') || t.ability === 'Sturdy')) amt = t.hp - 1;
  if (t.hp >= 99.5 && t.ability === 'Disguise' && t.card.species.startsWith('Mimikyu')) amt = 12;
  amt = Math.min(amt, t.hp);
  t.hp -= amt;
  if (t.hp <= 0.01) { t.hp = 0; t.fainted = true; }
  // secondary effects
  const sec = d.secondary;
  if (sec && sec.chance >= 100 && r.avgPct > 0 && !t.fainted && t.ability !== 'Shield Dust' && t.item !== 'Covert Cloak') {
    if (sec.volatileStatus === 'flinch' && !t.acted && t.ability !== 'Inner Focus') t.flinch = true;
    if (sec.boosts) applyBoosts(t, sec.boosts, true);
    if (sec.status && canStatus(t, sec.status, f)) t.status = sec.status;
  }
  if (amt > 0 && !t.fainted) {
    if (t.item === 'Weakness Policy' && superEff(d.type, t.types)) { applyBoosts(t, { atk: 2, spa: 2 }, false); t.item = ''; t.itemUsed = true; }
    if (t.item === 'Sitrus Berry' && t.hp < 50) { t.hp = Math.min(100, t.hp + 25); t.item = ''; t.itemUsed = true; }
    if (d.flags?.contact && m.ability !== 'Magic Guard' && m.item !== 'Protective Pads' && m.ability !== 'Long Reach') {
      let rec = 0;
      if (t.item === 'Rocky Helmet') rec += 100 / 6;
      if (t.ability === 'Rough Skin' || t.ability === 'Iron Barbs') rec += 12.5;
      m.hp -= rec;
    }
  }
  // recoil / drain (convert % of target HP to % of attacker HP)
  const scale = t.maxHp / m.maxHp;
  if (d.recoil && m.ability !== 'Rock Head' && m.ability !== 'Magic Guard') m.hp -= amt * scale * d.recoil[0] / d.recoil[1];
  if (d.drain) m.hp = Math.min(100, m.hp + amt * scale * d.drain[0] / d.drain[1]);
  return amt;
}

const SEMI_INVULN = new Set(['Fly', 'Bounce', 'Dig', 'Dive', 'Phantom Force', 'Shadow Force', 'Sky Drop']);
function skipCharge(m: SM, move: string, f: SF): boolean {
  if (m.item === 'Power Herb') return true;
  if ((move === 'Solar Beam' || move === 'Solar Blade') && f.weather === 'SunnyDay') return true;
  if (move === 'Electro Shot' && f.weather === 'RainDance') return true;
  return false;
}
function doMove(s: Sim, m: SM, a: Act) {
  const d = mv(a.move!);
  if (a.move === 'Fake Out' || a.move === 'First Impression') { if (!m.firstTurn) return; }
  if (d.category === 'Status') { doStatusMove(s, m, a); return; }
  if (d.flags?.charge) {
    if (m.charging) { m.charging = undefined; m.invuln = false; }
    else if (!skipCharge(m, a.move!, s.f)) {
      m.charging = a.move; m.chargeTgt = a.tgt;
      if (SEMI_INVULN.has(a.move!)) m.invuln = true;
      if (a.move === 'Meteor Beam' || a.move === 'Electro Shot') applyBoosts(m, { spa: 1 }, false);
      if (a.move === 'Skull Bash') applyBoosts(m, { def: 1 }, false);
      m.lastMove = a.move;
      return;
    }
  }
  const f = s.f;
  let targets: SM[] = [];
  if (d.target === 'allAdjacentFoes' || d.target === 'allAdjacent') {
    targets = s.act[1 - m.side].filter(x => x && !x.fainted) as SM[];
    if (d.target === 'allAdjacent') { const al = s.act[m.side][1 - m.slot]; if (al && !al.fainted) targets.push(al); }
  } else if (a.tgt && a.tgt < 0) {
    const t = s.act[m.side][-a.tgt - 1];
    if (t && !t.fainted) targets = [t];
  } else {
    let t = foeOf(s, m, a.tgt);
    const red = f.redirect[1 - m.side];
    if (red && !red.fainted && t !== red && m.ability !== 'Stalwart' && m.ability !== 'Propeller Tail' && a.move !== 'Snipe Shot') {
      const powderImmune = m.types.includes('Grass') || m.ability === 'Overcoat' || m.item === 'Safety Goggles';
      if (!(f.redirect[1 - m.side] && powderImmune && redirectMove(red) === 'Rage Powder')) t = red;
    }
    if (t) targets = [t];
  }
  let dealt = 0;
  for (const t of targets) dealt += hit(s, m, t, a, d, targets.length);
  m.hh = false; m.lastMove = a.move;
  if (dealt > 0 && m.item === 'Life Orb' && m.ability !== 'Magic Guard' && m.ability !== 'Sheer Force') m.hp -= 10;
  if (d.self?.boosts && targets.length) applyBoosts(m, d.self.boosts, false);
  if (d.secondary?.self?.boosts && d.secondary.chance >= 100 && dealt > 0) applyBoosts(m, d.secondary.self.boosts, false);
  if (m.hp <= 0.01) { m.hp = 0; m.fainted = true; }
}
const redirectMoves = new WeakMap<SM, string>();
function redirectMove(m: SM) { return redirectMoves.get(m) ?? 'Follow Me'; }

/** Run one turn. acts[side][slot]. Mutates s. */
export function simulate(s: Sim, acts: (Act | null)[][]) {
  const f = s.f;
  type Q = { m: SM; a: Act; side: number; slot: number };
  const queue: Q[] = [];
  // switches happen first
  for (let side = 0; side < 2; side++) for (let slot = 0; slot < 2; slot++) {
    const a = acts[side][slot];
    if (a?.kind === 'switch' && a.sw) {
      const old = s.act[side][slot];
      if (old) { old.boosts = {}; s.out.push(old); }
      const n = cloneMon(a.sw); n.slot = slot; n.side = side as 0 | 1; n.acted = true; n.firstTurn = false;
      s.act[side][slot] = n; s.inn.push(a.sw);
      if (n.ability === 'Intimidate') for (const t of s.act[1 - side]) if (t && !t.fainted && !INTIM_IMMUNE.has(t.ability)) applyBoosts(t, { atk: -1 }, true);
    }
  }
  for (let side = 0; side < 2; side++) for (let slot = 0; slot < 2; slot++) {
    const a = acts[side][slot], m = s.act[side][slot];
    if (m) m.curMove = a?.kind === 'move' ? a.move : undefined;
    if (!a || !m || m.fainted || a.kind !== 'move' || !a.move) continue;
    const name = a.move;
    if (PROTECTS.has(name) || name === 'Wide Guard') doStatusMove(s, m, a), (m.acted = true);
    else {
      if (REDIRECT.has(name)) { redirectMoves.set(m, name); f.redirect[side] = m; }
      if (name === 'Helping Hand') { const al = s.act[side][1 - slot]; if (al && !al.fainted) al.hh = true; m.acted = true; continue; }
      queue.push({ m, a, side, slot });
    }
  }
  while (queue.length) {
    // dynamic speed order (Gen 8+)
    let bi = 0, bp = -99, bs = 0;
    for (let i = 0; i < queue.length; i++) {
      const q = queue[i];
      const p = priorityOf(q.m, q.a, f);
      let sp = effSpeed(q.m, f);
      if (f.tr > 0) sp = -sp;
      // ties: opponent first (pessimistic)
      sp += q.side === 1 ? 0.001 : 0;
      if (p > bp || (p === bp && sp > bs)) { bi = i; bp = p; bs = sp; }
    }
    const q = queue.splice(bi, 1)[0];
    const m = q.m;
    if (m.fainted || s.act[q.side][q.slot] !== m) continue;
    if (m.flinch || m.status === 'slp' || m.status === 'frz') { m.acted = true; continue; }
    doMove(s, m, q.a);
    if (SIMLOG.on) console.log(`    [sim] ${m.side ? "opp" : "me"} ${m.card.species} ${q.a.move}${q.a.tgt ?? ""} -> ${s.act.map(r => r.map(x => x ? x.card.species + ":" + x.hp.toFixed(0) : "-").join(",")).join(" | ")}`);
    m.acted = true;
  }
  if (P.EOT) endOfTurn(s);
}

// ---------- evaluation ----------
function boostVal(m: SM) {
  const b = m.boosts;
  const off = m.physical ? (b.atk ?? 0) : (b.spa ?? 0);
  return 10 * off + 5 * ((b.def ?? 0) + (b.spd ?? 0)) / 2;
}
function statusVal(m: SM) {
  switch (m.status) {
    case 'brn': return m.physical ? -25 : -8;
    case 'par': return -10;
    case 'slp': return -35;
    case 'frz': return -35;
    case 'tox': return -14;
    case 'psn': return -8;
  }
  return 0;
}
const WORTH = new Map<string, number>();
const worthKey = { k: '' };
function computeWorth(v: BattleView) {
  const k = v.myTeam.map(c => c.id).join() + '/' + v.oppTeam.map(c => c.id).join();
  if (worthKey.k === k) return;
  worthKey.k = k; WORTH.clear();
  const raw = (c: Card, foes: Card[]) => {
    let s = 0;
    for (const o of foes) { let b = 0; for (const mvn of c.moves) { const r = moveDamage(c, o, mvn); if (r) b = Math.max(b, r.avgPct); } s += Math.min(100, b); }
    return s / foes.length;
  };
  for (const [team, foes] of [[v.myTeam, v.oppTeam], [v.oppTeam, v.myTeam]] as Card[][][]) {
    const vals = team.map(c => raw(c, foes));
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length || 1;
    team.forEach((c, i) => WORTH.set(c.id, 1 + P.WORTH * (vals[i] / mean - 1)));
  }
}
function monVal(m: SM, onField: boolean) {
  if (m.fainted || m.hp <= 0) return 0;
  const w = P.WORTH ? (WORTH.get(m.card.id) ?? 1) : 1;
  return w * (P.ALIVE + m.hp) + (onField ? boostVal(m) : 0) + statusVal(m);
}
export function evaluate(s: Sim): number {
  let v = 0;
  for (const side of [0, 1]) {
    const sign = side === 0 ? 1 : -1;
    for (const m of s.act[side]) if (m) v += sign * monVal(m, true);
  }
  for (const m of s.out) v += (m.side === 0 ? 1 : -1) * monVal(m, false);
  for (const m of s.inn) v -= (m.side === 0 ? 1 : -1) * monVal(m, false);
  // speed control next turn
  const f = s.f;
  const tw: [number, number] = [f.tw[0] - 1, f.tw[1] - 1];
  const tr = f.tr - 1 > 0;
  for (const a of s.act[0]) for (const b of s.act[1]) {
    if (!a || !b || a.fainted || b.fainted) continue;
    const sa = effSpeed(a, f, tw[0]), sb = effSpeed(b, f, tw[1]);
    if (sa === sb) continue;
    v += ((sa > sb) !== tr ? 1 : -1) * P.SPEED_K;
  }
  v += P.SCREEN * (Math.min(f.screens[0], 2) - Math.min(f.screens[1], 2));
  return v;
}

// ---------- opponent prediction ----------
interface Cand { act: Act; h: number; kills: number[] }
function oppSlotCands(s: Sim, side: 0 | 1, slot: number): Cand[] {
  const m = s.act[side][slot];
  if (!m || m.fainted) return [{ act: { kind: 'pass' }, h: 0, kills: [] }];
  const out: Cand[] = [];
  const foes = s.act[1 - side];
  if (m.charging) return m.chargeTgt ? [{ act: { kind: 'move', move: m.charging, tgt: m.chargeTgt }, h: 50, kills: [] }]
    : [1, 2].filter(x => foes[x - 1] && !foes[x - 1]!.fainted).map(x => ({ act: { kind: 'move' as const, move: m.charging, tgt: x }, h: 50, kills: [] }));
  let moves = m.card.moves;
  if (m.item.startsWith('Choice') && m.lastMove && moves.includes(m.lastMove)) moves = [m.lastMove];
  // threat to this mon: max damage either of my mons can do
  let threat = 0;
  if (m.card.moves.some(x => PROTECTS.has(x))) for (const e of foes) if (e && !e.fainted) for (const mvn of e.card.moves) { const r = dmg(e, m, mvn, s.f); if (r) threat = Math.max(threat, r.avgPct); }
  for (const name of moves) {
    const d = mv(name);
    if (!d.exists) continue;
    if ((name === 'Fake Out' || name === 'First Impression') && !m.firstTurn) continue;
    if (d.category === 'Status') {
      if (m.item === 'Assault Vest') continue;
      let h = 4;
      if (PROTECTS.has(name)) { if (m.protLast) continue; h = 6 + (threat >= m.hp ? 30 : threat >= m.hp * 0.6 ? 12 : 0); }
      else if (name === 'Tailwind') h = s.f.tw[side] > 0 ? -20 : 30;
      else if (name === 'Trick Room') {
        let slower = 0;
        for (const a of s.act[side]) for (const b of foes) if (a && b && !a.fainted && !b.fainted) slower += effSpeed(a, s.f) < effSpeed(b, s.f) ? 1 : -1;
        h = s.f.tr > 0 ? -40 : slower > 0 ? 35 : -10;
      } else if (REDIRECT.has(name)) h = 18;
      else if (name === 'Helping Hand') h = 14;
      else if (SLEEP.has(name)) h = 30;
      else if (name === 'Thunder Wave' || name === 'Will-O-Wisp' || name === 'Toxic') h = 16;
      else if (HEALS.has(name)) h = Math.max(0, (100 - m.hp) * 0.5 - 5);
      else if (d.boosts && d.target === 'self') h = 12;
      if (d.target === 'normal' || d.target === 'adjacentFoe' || d.target === 'any') {
        for (const t of [1, 2]) { const e = foes[t - 1]; if (e && !e.fainted) out.push({ act: { kind: 'move', move: name, tgt: t }, h, kills: [] }); }
      } else out.push({ act: { kind: 'move', move: name }, h, kills: [] });
      continue;
    }
    const spread = d.target === 'allAdjacentFoes' || d.target === 'allAdjacent';
    if (spread) {
      let h = 0; const kills: number[] = [];
      for (const e of foes) if (e && !e.fainted) { const r = dmg(m, e, name, s.f); if (r) { h += Math.min(r.avgPct, e.hp); if ((P.OPP_MINKO ? r.minPct : r.avgPct) >= e.hp) { h += P.OPP_KO; kills.push(e.slot); } } }
      if (d.target === 'allAdjacent') { const al = s.act[side][1 - slot]; if (al && !al.fainted) { const r = dmg(m, al, name, s.f); if (r) h -= 1.5 * Math.min(r.avgPct, al.hp) + (r.avgPct >= al.hp ? 80 : 0); } }
      if (name === 'Fake Out') h += P.OPP_FO;
      out.push({ act: { kind: 'move', move: name }, h, kills });
    } else {
      for (const t of [1, 2]) {
        const e = foes[t - 1];
        if (!e || e.fainted) continue;
        const r = dmg(m, e, name, s.f);
        let h = 0; const kills: number[] = [];
        if (r) { h = Math.min(r.avgPct, e.hp); if ((P.OPP_MINKO ? r.minPct : r.avgPct) >= e.hp) { h += P.OPP_KO; kills.push(e.slot); } }
        if (name === 'Fake Out') h += P.OPP_FO;
        if (d.secondary?.chance >= 100 && d.secondary.boosts?.spe) h += 6;
        out.push({ act: { kind: 'move', move: name, tgt: t }, h, kills });
      }
    }
  }
  for (const c of out) if (c.act.move && mv(c.act.move).flags?.charge && !skipCharge(m, c.act.move, s.f)) { c.h *= 0.5; c.kills = []; }
  if (!out.length) out.push({ act: { kind: 'pass' }, h: 0, kills: [] });
  out.sort((a, b) => b.h - a.h);
  return out;
}

function topJoint(s: Sim, side: 0 | 1, perSlot: number, top: number): { acts: Act[]; h: number }[] {
  const c0 = oppSlotCands(s, side, 0), c1 = oppSlotCands(s, side, 1);
  const pick = (c: Cand[]) => {
    const r = c.slice(0, perSlot);
    const prot = c.find(x => x.act.move && PROTECTS.has(x.act.move));
    if (prot && !r.includes(prot)) r.push(prot);
    return r;
  };
  const a0 = pick(c0), a1 = pick(c1);
  const joint: { acts: Act[]; h: number }[] = [];
  for (const x of a0) for (const y of a1) {
    let h = x.h + y.h;
    if (x.kills.length && y.kills.length && x.kills.some(k => y.kills.includes(k))) h -= 35;
    joint.push({ acts: [x.act, y.act], h });
  }
  joint.sort((a, b) => b.h - a.h);
  return joint.slice(0, top);
}

function smartOpp(sim: Sim): { acts: Act[]; h: number }[] {
  const all = topJoint(sim, 1, 4, 100);
  const mine = topJoint(sim, 0, 3, 3);
  for (const o of all) {
    let v = 0;
    for (const mj of mine) { const s = cloneSim(sim); simulate(s, [mj.acts, o.acts]); v += evaluate(s); }
    o.h = P.SMART * (-v / mine.length) + (1 - P.SMART) * o.h;
  }
  all.sort((a, b) => b.h - a.h);
  return all.slice(0, P.OPP_TOP_JOINT);
}

// ---------- rollout ----------
function fillReplacements(s: Sim) {
  if (!s.bench || !P.FILL) return;
  for (const side of [0, 1]) for (const slot of [0, 1]) {
    const cur = s.act[side][slot];
    if (cur && !cur.fainted) continue;
    const taken = (b: SM) => s.inn.includes(b) || s.act[side].some(x => x && x.card.id === b.card.id) || s.out.some(x => x.card.id === b.card.id);
    const cands = s.bench[side].filter(b => !taken(b));
    if (!cands.length) continue;
    let pick = cands[0];
    if (side === 0 && cands.length > 1) { let bv = -Infinity; for (const c of cands) { const v = matchupScore(c, s); if (v > bv) { bv = v; pick = c; } } }
    const n = cloneMon(pick); n.slot = slot; n.side = side as 0 | 1; n.firstTurn = true;
    if (cur) s.out.push(cur);
    s.act[side][slot] = n; s.inn.push(pick);
  }
}
function nextTurnPrep(s: Sim) {
  fillReplacements(s);
  for (const row of s.act) for (const m of row) if (m) {
    m.protLast = m.protect; m.protect = false; m.flinch = false; m.acted = false; m.firstTurn = false; m.hh = false;
  }
  s.f.tw = [Math.max(0, s.f.tw[0] - 1), Math.max(0, s.f.tw[1] - 1)];
  s.f.tr = Math.max(0, s.f.tr - 1);
  s.f.redirect = [null, null]; s.f.wideGuard = [false, false];
}
function rolloutValue(s: Sim): number {
  const v1 = evaluate(s);
  if (P.ROLL <= 0) return v1;
  nextTurnPrep(s);
  const theirs = topJoint(s, 1, 2, 1)[0].acts;
  if (P.DEEP > 1) {
    let best = -Infinity;
    for (const mj of topJoint(s, 0, 2, P.DEEP)) {
      const s2 = cloneSim(s);
      simulate(s2, [mj.acts, theirs]);
      best = Math.max(best, evaluate(s2));
    }
    return (1 - P.ROLL) * v1 + P.ROLL * best;
  }
  const mine = topJoint(s, 0, 2, 1)[0].acts;
  simulate(s, [mine, theirs]);
  let v2 = evaluate(s);
  if (P.ROLL2 > 0) {
    nextTurnPrep(s);
    simulate(s, [topJoint(s, 0, 2, 1)[0].acts, topJoint(s, 1, 2, 1)[0].acts]);
    let v3 = evaluate(s);
    if (P.ROLL3 > 0) {
      nextTurnPrep(s);
      simulate(s, [topJoint(s, 0, 2, 1)[0].acts, topJoint(s, 1, 2, 1)[0].acts]);
      v3 = (1 - P.ROLL3) * v3 + P.ROLL3 * evaluate(s);
    }
    v2 = (1 - P.ROLL2) * v2 + P.ROLL2 * v3;
  }
  return (1 - P.ROLL) * v1 + P.ROLL * v2;
}
// ---------- position value (used for forced switches) ----------
function positionValue(sim: Sim): number {
  const oppJ = topJoint(sim, 1, 3, 5);
  const maxH = Math.max(...oppJ.map(o => o.h));
  const w = oppJ.map(o => Math.exp((o.h - maxH) / P.OPP_TEMP));
  const wsum = w.reduce((a, b) => a + b, 0);
  const mine = topJoint(sim, 0, 3, 8);
  let best = -Infinity;
  for (const mj of mine) {
    let ev = 0, worst = Infinity;
    for (let k = 0; k < oppJ.length; k++) {
      const s = cloneSim(sim);
      simulate(s, [mj.acts, oppJ[k].acts]);
      const val = rolloutValue(s);
      ev += val * w[k] / wsum;
      if (val < worst) worst = val;
    }
    best = Math.max(best, P.LAMBDA * ev + (1 - P.LAMBDA) * worst);
  }
  return best;
}

// ---------- building the sim from the view ----------
function buildSim(v: BattleView): { sim: Sim; myBench: Map<number, SM> } {
  const st0 = v.state;
  const fs = st0.field;
  const f: SF = {
    tw: [fs.tailwind.me, fs.tailwind.opp], tr: fs.trickRoom, weather: fs.weather, terrain: fs.terrain,
    screens: [fs.screens.me.filter(x => /Reflect|Light Screen|Aurora Veil/.test(x)).length, fs.screens.opp.filter(x => /Reflect|Light Screen|Aurora Veil/.test(x)).length],
    redirect: [null, null], wideGuard: [false, false],
  };
  const act: (SM | null)[][] = [[null, null], [null, null]];
  const req = v.request;
  const myBench = new Map<number, SM>();
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
      if (card && !fainted) act[0][s] = mkMon(0, s, card, { ...(ms ?? {}), hpPct, status: status === 'fnt' ? '' : status });
    } else if (card && !fainted) {
      myBench.set(i + 1, mkMon(0, -1, card, { hpPct, status, boosts: {}, turnsOnField: 5 }));
    }
  });
  for (const m of st0.opp) {
    if (!m.active || m.fainted || m.slot < 0 || !m.card) continue;
    act[1][m.slot] = mkMon(1, m.slot, m.card, m);
  }
  // two-turn moves charged last turn
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
    for (const m of act[sideIdx]) if (m && m.card && (m.card.species === name || st0[sideIdx ? 'opp' : 'my'].some(x => x.active && x.slot === m.slot && x.ident.endsWith(': ' + name)))) {
      m.charging = mvName; m.chargeTgt = undefined;
      if (SEMI_INVULN.has(mvName)) m.invuln = true;
    }
  }
  if (P.RUIN || P.FG) {
    const ruin = new Set<string>();
    f.fg = ['', ''];
    act.forEach((row, side) => row.forEach(m => {
      if (!m) return;
      if (m.ability.endsWith(' of Ruin')) ruin.add(m.ability);
      if (m.ability === 'Friend Guard') f.fg![side] = m.card.id;
    }));
    f.ruin = [...ruin];
  }
  const oppBench: SM[] = [];
  for (const m of st0.opp) if (!m.active && !m.fainted && m.card) oppBench.push(mkMon(1, -1, m.card, { ...m, boosts: {}, turnsOnField: 5 }));
  const unrevealed = 4 - st0.opp.length;
  if (unrevealed > 0) {
    const seen = new Set(st0.opp.map(m => m.card?.id));
    const rest = v.oppTeam.filter(c => !seen.has(c.id)).map(c => ({ c, s: v.myTeam.reduce((a, o) => a + oneVsOne(c, o), 0) })).sort((a, b) => b.s - a.s);
    for (const r of rest.slice(0, unrevealed)) oppBench.push(mkMon(1, -1, r.c, { hpPct: 100, turnsOnField: 5 }));
  }
  return { sim: { act, out: [], inn: [], f, bench: [[...myBench.values()], oppBench] }, myBench };
}

function optToAct(o: SlotOption, bench: Map<number, SM>): Act {
  if (o.kind === 'switch') return { kind: 'switch', sw: bench.get(o.switchTo!) };
  if (o.kind === 'pass' || !o.move) return { kind: 'pass' };
  if (o.move === 'Struggle') return { kind: 'pass' };
  return { kind: 'move', move: o.move, tgt: o.target };
}

// ---------- forced switch ----------
function matchupScore(c: SM, sim: Sim): number {
  let sc = c.hp * 0.3;
  for (const e of sim.act[1]) {
    if (!e || e.fainted) continue;
    let off = 0, def = 0;
    for (const m of c.card.moves) { const r = dmg(c, e, m, sim.f); if (r) off = Math.max(off, Math.min(r.avgPct, e.hp)); }
    for (const m of e.card.moves) { const r = dmg(e, c, m, sim.f); if (r) def = Math.max(def, Math.min(r.avgPct, c.hp)); }
    const faster = (effSpeed(c, sim.f) > effSpeed(e, sim.f)) !== (sim.f.tr > 0);
    sc += off * (faster ? 1.3 : 1) - def * (faster ? 1 : 1.3);
    if (off >= e.hp) sc += faster ? 30 : 10;
    if (def >= c.hp) sc -= faster ? 10 : 30;
  }
  return sc;
}

// ---------- prediction accuracy (debug) ----------
const PREDSTAT = !!process.env.BATTLER_PREDSTAT;
let lastPred: { names: string[]; top: string[]; any: string[][] } | null = null;
const pstat = { n: 0, top: 0, any: 0, moveTop: 0 };
function predStat(v: BattleView, sim: Sim, oppJ: { acts: Act[]; h: number }[]) {
  const log = v.state.log;
  let end = log.length - 1;
  while (end >= 0 && !log[end].startsWith('|turn|')) end--;
  let start = end - 1;
  while (start >= 0 && !log[start].startsWith('|turn|')) start--;
  if (lastPred && start >= 0) {
    for (let i = start; i < end; i++) {
      const p = log[i].split('|');
      if (p[1] !== 'move' || p[2].startsWith(v.state.mySide)) continue;
      if (log[i].includes('[from]')) continue;
      const slot = p[2][2] === 'a' ? 0 : 1;
      const tgtSlot = p[4] ? (p[4][2] === 'a' ? 1 : 2) : 0;
      const key = p[3] + (tgtSlot && p[4].startsWith(v.state.mySide) ? tgtSlot : '');
      if (!lastPred.top[slot]) continue;
      pstat.n++;
      if (lastPred.top[slot] === key) pstat.top++;
      if (lastPred.top[slot].replace(/[12]$/, '') === p[3]) pstat.moveTop++;
      if (lastPred.any[slot].includes(key)) pstat.any++;
      else if (process.env.BATTLER_PREDSTAT === '2') console.error('MISS', log[i], '| pred', lastPred.any[slot].join(','));
    }
  }
  const k = (a: Act) => (a.move ? a.move + (a.tgt ?? '') : a.kind);
  lastPred = { names: [], top: [0, 1].map(i => k(oppJ[0].acts[i])), any: [0, 1].map(i => oppJ.map(o => k(o.acts[i]))) };
}
process.on('exit', () => { if (PREDSTAT && pstat.n) console.error(`[pred] n=${pstat.n} top=${(pstat.top / pstat.n).toFixed(3)} moveTop=${(pstat.moveTop / pstat.n).toFixed(3)} any=${(pstat.any / pstat.n).toFixed(3)}`); });

// ---------- adaptive opponent model ----------
const actKey = (a: Act) => (a.move ? a.move + (a.tgt ?? '') : a.kind);
interface AdaptInfo { pend?: { h: string[]; s: string[] }; hh: number; hs: number }
const adaptMem = new WeakMap<object, AdaptInfo>();
function adaptMix(v: BattleView, hj: { acts: Act[] }[], sj: { acts: Act[] }[]): number {
  let info = adaptMem.get(v.state);
  if (!info) { info = { hh: 0, hs: 0 }; adaptMem.set(v.state, info); }
  if (info.pend && P.ADAPT) {
    const log = v.state.log;
    let end = log.length - 1;
    while (end >= 0 && !log[end].startsWith('|turn|')) end--;
    let start = end - 1;
    while (start >= 0 && !log[start].startsWith('|turn|')) start--;
    for (let i = Math.max(0, start); i < end; i++) {
      const p = log[i].split('|');
      if (p[1] !== 'move' || p[2].startsWith(v.state.mySide) || log[i].includes('[from]')) continue;
      const slot = p[2][2] === 'a' ? 0 : 1;
      const spread = log[i].includes('[spread]');
      const tgt = !spread && p[4] && p[4].startsWith(v.state.mySide) ? (p[4][2] === 'a' ? '1' : '2') : '';
      const key = p[3] + tgt;
      const hk = info.pend.h[slot], sk = info.pend.s[slot];
      if (!hk || !sk || hk === sk) continue;
      if (hk === key) info.hh++;
      if (sk === key) info.hs++;
    }
  }
  info.pend = { h: [0, 1].map(i => actKey(hj[0].acts[i])), s: [0, 1].map(i => actKey(sj[0].acts[i])) };
  if (!P.ADAPT) return P.MIX;
  const lg = Math.log(P.MIX / (1 - P.MIX)) + P.ADAPT * (info.hs - info.hh);
  return 1 / (1 + Math.exp(-lg));
}

// ---------- main ----------
export const stats_ = { calls: 0, ms: 0 };
const TRACE = !!process.env.BATTLER_TRACE;
export const SIMLOG = { on: false };
export function chooseBattleAction(v: BattleView): string {
  const t0 = performance.now();
  try {
    return decide(v);
  } finally {
    stats_.calls++; stats_.ms += performance.now() - t0;
  }
}

function decide(v: BattleView): string {
  const req = v.request;
  const opts = slotOptions(req);
  const joints = jointChoices(opts);
  if (joints.length === 1) return joints[0].choice;
  if (P.WORTH) computeWorth(v);
  const { sim, myBench } = buildSim(v);

  if (req.forceSwitch) {
    let best = joints[0].choice, bv = -Infinity;
    for (const j of joints) {
      let val = 0;
      if (P.FSIM) {
        const s = cloneSim(sim);
        const placed = new Set<number>();
        j.parts.forEach((p, slot) => {
          if (p.kind !== 'switch') return;
          const b = myBench.get(p.switchTo!);
          if (!b) return;
          const n = cloneMon(b); n.slot = slot; n.side = 0; n.firstTurn = true;
          s.act[0][slot] = n; placed.add(p.switchTo!);
        });
        val = positionValue(s);
        for (const [k, b] of myBench) if (!placed.has(k)) val += monVal(b, false);
      } else for (const p of j.parts) if (p.kind === 'switch') { const b = myBench.get(p.switchTo!); if (b) val += matchupScore(b, sim); }
      if (val > bv) { bv = val; best = j.choice; }
    }
    return best;
  }

  let oppJ: { acts: Act[]; h: number }[];
  let w: number[];
  const softmax = (arr: { h: number }[]) => {
    const mx = Math.max(...arr.map(o => o.h));
    const e = arr.map(o => Math.exp((o.h - mx) / P.OPP_TEMP));
    const sum = e.reduce((a, b) => a + b, 0);
    return e.map(x => x / sum);
  };
  if (P.MIX > 0) {
    const hj = topJoint(sim, 1, P.OPP_TOP_SLOT, P.OPP_TOP_JOINT);
    const sj = smartOpp(sim);
    const M = adaptMix(v, hj, sj);
    const hw = softmax(hj), sw = softmax(sj);
    const map = new Map<string, { acts: Act[]; h: number; w: number }>();
    const add = (o: { acts: Act[]; h: number }, wt: number) => {
      const k = o.acts.map(actKey).join('+');
      const e = map.get(k);
      if (e) e.w += wt; else map.set(k, { acts: o.acts, h: o.h, w: wt });
    };
    hj.forEach((o, i) => add(o, (1 - M) * hw[i]));
    sj.forEach((o, i) => add(o, M * sw[i]));
    oppJ = [...map.values()].sort((a, b) => b.w - a.w).slice(0, P.MIX_TOP);
    w = oppJ.map(o => (o as any).w);
  } else {
    oppJ = P.SMART > 0 ? smartOpp(sim) : topJoint(sim, 1, P.OPP_TOP_SLOT, P.OPP_TOP_JOINT);
    w = softmax(oppJ);
  }
  if (PREDSTAT) predStat(v, sim, oppJ);
  const wsum = w.reduce((a, b) => a + b, 0);

  let best = joints[0].choice, bestScore = -Infinity;
  const trace: { c: string; ev: number; worst: number; score: number }[] = [];
  const cands: { j: typeof joints[number]; myActs: (Act | null)[]; tie: number }[] = [];
  for (const j of joints) {
    const myActs = [0, 1].map(i => (j.parts[i] ? optToAct(j.parts[i], myBench) : null));
    // static pruning of nonsense
    if (myActs.some(a => a?.kind === 'switch' && !a.sw)) continue;
    if (P.NOSWITCH && myActs.some(a => a?.kind === 'switch')) continue;
    if (P.NOPROTECT && myActs.some(a => a?.move && PROTECTS.has(a.move))) continue;
    if (myActs.some((a, i) => a?.move && PROTECTS.has(a.move) && sim.act[0][i]?.protLast)) continue;
    let tie = 0;
    myActs.forEach((a, i) => {
      const me = sim.act[0][i];
      if (!me || !a?.move || !a.tgt || a.tgt < 0) return;
      const t = sim.act[1][a.tgt - 1];
      if (!t || t.fainted) return;
      const r = dmg(me, t, a.move, sim.f);
      if (r) tie += Math.min(r.avgPct, t.hp) * (r.avgPct >= t.hp ? 2 : 1);
    });
    cands.push({ j, myActs, tie });
  }
  const scoreJoint = (myActs: (Act | null)[], full: boolean) => {
    let ev = 0, worst = Infinity;
    for (let k = 0; k < oppJ.length; k++) {
      let val = 0;
      if (!full) { const s = cloneSim(sim); simulate(s, [myActs, oppJ[k].acts]); val = evaluate(s); }
      else for (const [lm, lo, wt] of SCEN) {
        LUCK[0] = lm; LUCK[1] = lo;
        const s = cloneSim(sim);
        simulate(s, [myActs, oppJ[k].acts]);
        val += wt * rolloutValue(s);
      }
      LUCK[0] = 0.5; LUCK[1] = 0.5;
      ev += val * w[k] / wsum;
      if (val < worst) worst = val;
    }
    return { ev, worst, score: P.LAMBDA * ev + (1 - P.LAMBDA) * worst };
  };
  let pool = cands;
  if (P.PRUNE > 0 && cands.length > P.PRUNE) {
    pool = cands.map(c => ({ c, s: scoreJoint(c.myActs, false).score + P.TIE * c.tie })).sort((a, b) => b.s - a.s).slice(0, P.PRUNE).map(x => x.c);
  }
  for (const { j, myActs, tie } of pool) {
    const { ev, worst, score: sc } = scoreJoint(myActs, true);
    const score = sc + P.TIE * tie;
    if (TRACE) trace.push({ c: j.choice, ev, worst, score });
    if (score > bestScore) { bestScore = score; best = j.choice; }
  }
  if (TRACE) {
    const nm = (m: SM | null) => (m ? `${m.card.species}(${m.hp.toFixed(0)})` : '-');
    console.log(`T${v.state.field.turn} me ${sim.act[0].map(nm).join(' ')} vs ${sim.act[1].map(nm).join(' ')}`);
    console.log('  opp pred: ' + oppJ.map((o, k) => `${o.acts.map(a => a.move ? a.move + (a.tgt ?? '') : a.kind).join('+')}:${(w[k] / wsum).toFixed(2)}`).join(' | '));
    trace.sort((a, b) => b.score - a.score);
    for (const t of trace.slice(0, 5)) console.log(`  ${t.c.padEnd(28)} ev ${t.ev.toFixed(1)} min ${t.worst.toFixed(1)} -> ${t.score.toFixed(1)}`);
    const bj = joints.find(j => j.choice === best)!;
    const s = cloneSim(sim);
    SIMLOG.on = true; simulate(s, [[0, 1].map(i => (bj.parts[i] ? optToAct(bj.parts[i], myBench) : null)), oppJ[0].acts]); SIMLOG.on = false;
    console.log(`  predicted vs top opp: me ${s.act[0].map(nm).join(' ')} vs ${s.act[1].map(nm).join(' ')}`);
  }
  return best;
}

if (process.env.BATTLER_TIME) {
  process.on('exit', () => { if (stats_.calls) console.error(`[battler] ${stats_.calls} decisions, ${(stats_.ms / stats_.calls).toFixed(2)} ms avg`); });
}
if (process.env.BATTLER_P) Object.assign(P, JSON.parse(process.env.BATTLER_P));
setScen();
