// Team-vs-team features for the draft win-rate predictor. Built only from set details, so they
// transfer to cards the model never saw.
import { Dex } from 'pokemon-showdown';
import type { Card } from '../types';
import { bestDamage, oneVsOne, speed, hasMove } from './pool';

const TAILWIND = ['Tailwind'];
const TRICK_ROOM = ['Trick Room'];
const SPEED_DROP = ['Icy Wind', 'Electroweb', 'Thunder Wave', 'Bulldoze', 'Glare', 'Nuzzle'];
const REDIRECT = ['Follow Me', 'Rage Powder'];
const PROTECT = ['Protect', 'Detect', 'Spiky Shield', "King's Shield", 'Baneful Bunker', 'Silk Trap', 'Burning Bulwark', 'Obstruct'];
const SLEEP = ['Spore', 'Sleep Powder', 'Hypnosis', 'Yawn', 'Dark Void', 'Lovely Kiss'];
const SUPPORT = ['Helping Hand', 'Wide Guard', 'Will-O-Wisp', 'Snarl', 'Parting Shot', 'Encore', 'Taunt', 'Pollen Puff', 'Life Dew', 'Coaching'];

export const FEATURE_NAMES = [
  'win_mean', 'win_top4', 'answers', 'ohko_answers', 'threat_taken', 'dmg_dealt',
  'speed_mean', 'outspeed', 'bst_mean', 'tailwind', 'trick_room', 'tr_fit', 'speed_drop',
  'fake_out', 'intimidate', 'redirect', 'sleep', 'protect', 'spread', 'priority', 'support',
  'weak_overlap', 'resist_cover', 'choice_items', 'sash',
];

const winCache = new Map<string, number>();
function win(a: Card, b: Card) {
  const k = a.id + '>' + b.id;
  let v = winCache.get(k);
  if (v === undefined) { v = oneVsOne(a, b); winCache.set(k, v); }
  return v;
}
const dmg = (a: Card, b: Card) => bestDamage(a, b)?.avgPct ?? 0;
const bst = (c: Card) => { const s = Dex.species.get(c.species).baseStats; return s.hp + s.atk + s.def + s.spa + s.spd + s.spe; };
const types = (c: Card) => Dex.species.get(c.species).types;
const eff = (atk: string, c: Card) => {
  if (!Dex.getImmunity(atk, types(c))) return 0;
  return 2 ** Dex.getEffectiveness(atk, types(c));
};
const ALL_TYPES = Dex.types.names().filter(t => t !== 'Stellar');

function spreadMoves(c: Card) {
  return c.moves.filter(m => { const d = Dex.moves.get(m); return d.category !== 'Status' && (d.target === 'allAdjacentFoes' || d.target === 'allAdjacent'); }).length;
}
function priorityMoves(c: Card) {
  return c.moves.filter(m => { const d = Dex.moves.get(m); return d.category !== 'Status' && d.priority > 0 && m !== 'Fake Out'; }).length;
}

/** Features of team T against opponent O (6 cards each, or any sizes). */
export function teamFeatures(T: Card[], O: Card[]): number[] {
  const n = T.length, m = O.length;
  const rows = T.map(t => O.map(o => win(t, o)));
  const rowSum = rows.map(r => r.reduce((s, x) => s + x, 0));
  const top4 = [...rowSum].sort((a, b) => b - a).slice(0, 4);
  const anyAns = O.map((o, j) => T.some((_, i) => rows[i][j] === 1));
  const ohko = O.map(o => T.some(t => dmg(t, o) >= 100));
  const threatTaken = T.map(t => Math.min(1.5, Math.max(...O.map(o => dmg(o, t))) / 100));
  const dealt = O.map(o => Math.min(1.5, Math.max(...T.map(t => dmg(t, o))) / 100));
  const spT = T.map(speed), spO = O.map(speed);
  let outs = 0;
  for (const a of spT) for (const b of spO) outs += a > b ? 1 : a === b ? 0.5 : 0;
  const any = (names: string[]) => (T.some(c => hasMove(c, ...names)) ? 1 : 0);
  const count = (names: string[]) => T.filter(c => hasMove(c, ...names)).length / n;
  const hasTR = any(TRICK_ROOM);
  const medO = [...spO].sort((a, b) => a - b)[Math.floor(m / 2)];
  const trFit = hasTR ? spT.filter(s => s < medO).length / n : 0;
  const weak = Math.max(...ALL_TYPES.map(t => T.filter(c => eff(t, c) > 1).length)) / n;
  // Fraction of the opponent's STAB types that at least two of my cards resist.
  const oppStab = [...new Set(O.flatMap(types))];
  const resist = oppStab.filter(t => T.filter(c => eff(t, c) < 1).length >= 2).length / Math.max(1, oppStab.length);
  return [
    rowSum.reduce((s, x) => s + x, 0) / (n * m),
    top4.reduce((s, x) => s + x, 0) / (4 * m),
    anyAns.filter(Boolean).length / m,
    ohko.filter(Boolean).length / m,
    threatTaken.reduce((s, x) => s + x, 0) / n,
    dealt.reduce((s, x) => s + x, 0) / m,
    spT.reduce((s, x) => s + x, 0) / n / 200,
    outs / (n * m),
    T.reduce((s, c) => s + bst(c), 0) / n / 600,
    any(TAILWIND),
    hasTR,
    trFit,
    any(SPEED_DROP),
    any(['Fake Out']),
    T.some(c => c.ability === 'Intimidate') ? 1 : 0,
    any(REDIRECT),
    any(SLEEP),
    count(PROTECT),
    T.reduce((s, c) => s + spreadMoves(c), 0) / n,
    T.reduce((s, c) => s + priorityMoves(c), 0) / n,
    count(SUPPORT),
    weak,
    resist,
    T.filter(c => c.item.startsWith('Choice')).length / n,
    T.filter(c => c.item === 'Focus Sash').length / n,
  ];
}

/** Antisymmetric matchup vector: positive values favour A. */
export function matchupVector(A: Card[], B: Card[]): number[] {
  const fa = teamFeatures(A, B), fb = teamFeatures(B, A);
  return fa.map((x, i) => x - fb[i]);
}
