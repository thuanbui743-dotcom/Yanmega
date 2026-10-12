// Card library: complete sets taken from Showdown's gen9 random doubles generator, set to level 50.
import * as fs from 'fs';
import * as path from 'path';
import { Teams, Dex } from 'pokemon-showdown';
import type { Card } from './types';
import { Rng } from './rng';

const LIB_PATH = path.join(__dirname, '..', 'data', 'cards.json');

export function buildLibrary(teams = 4000): Card[] {
  const seen = new Map<string, Card>();
  for (let i = 0; i < teams; i++) {
    for (const s of Teams.generate('gen9randomdoublesbattle')) {
      if (!s.item) continue;
      const moves = s.moves.map((m: string) => Dex.moves.get(m).name);
      const key = `${s.species}|${s.item}|${s.ability}|${[...moves].sort().join(',')}`;
      if (seen.has(key)) continue;
      seen.set(key, {
        id: `c${seen.size}`,
        species: s.species,
        item: s.item,
        ability: s.ability,
        nature: s.nature || 'Serious',
        evs: s.evs, ivs: s.ivs,
        moves,
        level: 50,
      });
    }
  }
  return [...seen.values()];
}

/** Competitive level-50 sets (Showdown's Battle Stadium factory data): real natures and EVs. */
export function buildBssLibrary(): Card[] {
  const data = require('pokemon-showdown/data/random-battles/gen9/bss-factory-sets.json');
  const cards: Card[] = [];
  const full = (evs: any) => ({ hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0, ...evs });
  for (const k of Object.keys(data)) {
    for (const s of data[k].sets) {
      cards.push({
        id: `b${cards.length}`,
        species: s.species,
        item: s.item[0],
        ability: s.ability[0],
        nature: s.nature,
        evs: full(s.evs),
        ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31, ...(s.ivs ?? {}) },
        moves: s.moves.map((opts: string[]) => opts[0]),
        level: 50,
      });
    }
  }
  return cards;
}

// VGC_CARDS=bss switches pools to the competitive set library (ids start with "b").
const SOURCE = process.env.VGC_CARDS === 'bss' ? 'bss' : 'random';
let cache: Card[] | null = null;
export function loadLibrary(): Card[] {
  if (cache) return cache;
  const file = SOURCE === 'bss' ? LIB_PATH.replace('cards.json', 'cards-bss.json') : LIB_PATH;
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(SOURCE === 'bss' ? buildBssLibrary() : buildLibrary()));
  }
  cache = JSON.parse(fs.readFileSync(file, 'utf8')) as Card[];
  return cache;
}

/** 18 cards with distinct species and no item used more than twice. */
export function drawPool(rng: Rng, size = 18): Card[] {
  const lib = loadLibrary();
  const pool: Card[] = [];
  const species = new Set<string>();
  const items = new Map<string, number>();
  while (pool.length < size) {
    const c = lib[rng.int(lib.length)];
    const base = Dex.species.get(c.species).baseSpecies;
    if (species.has(base) || (items.get(c.item) ?? 0) >= 2) continue;
    species.add(base);
    items.set(c.item, (items.get(c.item) ?? 0) + 1);
    pool.push(c);
  }
  return pool;
}

export function toPackedTeam(cards: Card[]): string {
  return Teams.pack(cards.map(c => ({
    name: c.species, species: c.species, item: c.item, ability: c.ability, nature: c.nature,
    evs: c.evs, ivs: c.ivs, moves: c.moves, level: c.level, gender: '',
  })) as any);
}
