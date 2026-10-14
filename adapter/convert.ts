// Converts AltruAgent platform observations (pokemon_vgc_doubles_draft over MCP) into the arena's bot views.
import { Dex } from 'pokemon-showdown';
import type { Card, DraftView, PreviewView, Side, StatsTable } from '../src/types';
import { SNAKE, legalFor } from '../src/draft';

export const toID = (s: string) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

const STATS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'] as const;
function fill(partial: any, d: number): StatsTable {
  const out: any = {};
  for (const k of STATS) out[k] = typeof partial?.[k] === 'number' ? partial[k] : d;
  return out;
}

/** A platform card ({card_id, species, item, ability, nature, level, evs, ivs, moves}) as an arena Card. */
export function toCard(c: any): Card {
  return {
    id: String(c.card_id),
    species: Dex.species.get(c.species).exists ? Dex.species.get(c.species).name : String(c.species),
    item: c.item ? Dex.items.get(c.item).name || c.item : '',
    ability: c.ability ? Dex.abilities.get(c.ability).name || c.ability : '',
    nature: c.nature || 'Serious',
    evs: fill(c.evs, 0),
    ivs: fill(c.ivs, 31),
    moves: (c.moves ?? []).map((m: string) => (Dex.moves.get(m).exists ? Dex.moves.get(m).name : m)),
    level: c.level ?? 50,
  };
}

// Static catalog of platform cards recorded from Testing matches before the deadline (card_id -> platform card).
// Used only to fill in a card we never saw in full (the opponent's first pick when we draft second).
import * as fs from 'fs';
import * as path from 'path';
const CATALOG_PATH = path.join(__dirname, '..', 'data', 'platform-cards.json');
const catalog: Record<string, any> = fs.existsSync(CATALOG_PATH) ? JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8')) : {};
let bss: Card[] | null = null;
function bssLibrary(): Card[] {
  if (!bss) {
    const p = path.join(__dirname, '..', 'data', 'cards-bss.json');
    bss = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : [];
  }
  return bss!;
}

/** Best available guess for a card known only by id and species. */
export function guessCard(cardId: string, species: string): Card {
  if (catalog[cardId]) return toCard(catalog[cardId]);
  const near = bssLibrary().find(c => toID(c.species) === toID(species));
  if (near) return { ...near, id: cardId };
  const sp = Dex.species.get(species);
  return {
    id: cardId, species: sp.exists ? sp.name : species, item: '', ability: sp.abilities?.[0] ?? '',
    nature: 'Serious', evs: fill({}, 84), ivs: fill({}, 31), moves: [], level: 50,
  };
}

/** A Pokémon as shown on the battle board or Team Preview (no nature or EVs) as an approximate Card. */
export function cardFromObserved(e: any): Card {
  const near = bssLibrary().find(c => toID(c.species) === toID(e.species));
  const sp = Dex.species.get(e.species);
  return {
    id: `obs-${toID(e.species)}`,
    species: sp.exists ? sp.name : String(e.name ?? e.species),
    item: e.item && e.item !== 'unknown_item' ? (Dex.items.get(e.item).name || e.item) : (near?.item ?? ''),
    ability: e.ability ? (Dex.abilities.get(e.ability).name || e.ability) : (near?.ability ?? sp.abilities?.[0] ?? ''),
    nature: near?.nature ?? 'Serious',
    evs: near?.evs ?? fill({}, 84),
    ivs: fill({}, 31),
    moves: (e.moves?.length ? e.moves : near?.moves ?? []).map((m: string) => (Dex.moves.get(m).exists ? Dex.moves.get(m).name : m)),
    level: 50,
  };
}

/** Per-match memory: every card seen, keyed by card id. */
export class MatchMemory {
  cards = new Map<string, Card>();
  myAgentId = '';
  myTeam: Card[] = [];
  oppTeam: Card[] = [];
  lastBattleObs: any = null;   // last full battle observation (used when the platform sends a placeholder)

  remember(list: any[] | undefined) {
    for (const c of list ?? []) if (c?.card_id && !this.cards.has(c.card_id)) this.cards.set(c.card_id, toCard(c));
  }
}

/** Draft observation -> DraftView. `legalIds` are the card ids the platform offers this pick. */
export function draftView(obs: any, mem: MatchMemory, legalIds: string[]): DraftView {
  mem.remember(obs.available_cards);
  const me: Side = obs.first_drafter === mem.myAgentId ? 'A' : 'B';
  const opp: Side = me === 'A' ? 'B' : 'A';
  const sideOf = (agentId: string): Side => (agentId === mem.myAgentId ? me : opp);
  const picks: Record<Side, Card[]> = { A: [], B: [] };
  for (const p of [...(obs.picks ?? [])].sort((a: any, b: any) => a.pick_number - b.pick_number)) {
    if (!mem.cards.has(p.card_id)) mem.cards.set(p.card_id, guessCard(p.card_id, p.species));
    picks[sideOf(p.seat_id)].push(mem.cards.get(p.card_id)!);
  }
  const available = (obs.available_card_ids ?? []).map((id: string) => mem.cards.get(id)).filter(Boolean) as Card[];
  const pool = [...mem.cards.values()];
  const legal = legalIds.length ? available.filter(c => legalIds.includes(c.id)) : legalFor(picks[me], available);
  return {
    me, pool, order: SNAKE, pickIndex: Math.max(0, (obs.pick_number ?? 1) - 1),
    picks, available, legal: legal.length ? legal : available, oppLegal: legalFor(picks[opp], available),
  };
}

/** Rosters after the draft, resolved from the cards remembered during the draft. */
export function resolveRosters(obs: any, mem: MatchMemory) {
  const byId = (entry: any): Card | undefined => {
    if (entry?.card_id && mem.cards.has(entry.card_id)) return mem.cards.get(entry.card_id);
    const sp = toID(entry?.species ?? entry?.name ?? entry);
    return [...mem.cards.values()].find(c => toID(c.species) === sp || toID(Dex.species.get(c.species).baseSpecies) === sp);
  };
  const mine = (obs.your_roster ?? []).map((e: any) => byId(e) ?? cardFromObserved(e)) as Card[];
  const theirs = (obs.opponent_roster ?? []).map((e: any) => byId(e) ?? cardFromObserved(e)) as Card[];
  if (mine.length === 6) mem.myTeam = mine;
  if (theirs.length === 6) mem.oppTeam = theirs;
}

/** Team Preview: the bot's 4 indices (leads first) as the platform's select_lineup species ids. */
export function lineupFromOrder(order: number[], myTeam: Card[], rosterIds: string[]) {
  const idFor = (c: Card) => rosterIds.find(r => toID(r) === toID(c.species))
    ?? rosterIds.find(r => toID(r) === toID(Dex.species.get(c.species).baseSpecies)) ?? toID(c.species);
  const bring = order.map(i => idFor(myTeam[i]));
  return { type: 'select_lineup', bring, leads: bring.slice(0, 2) };
}

export function previewView(mem: MatchMemory): PreviewView {
  return { me: 'A', myTeam: mem.myTeam, oppTeam: mem.oppTeam };
}
