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

/** Per-match memory: every card seen, keyed by card id. */
export class MatchMemory {
  cards = new Map<string, Card>();
  myAgentId = '';
  myTeam: Card[] = [];
  oppTeam: Card[] = [];

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
    const c = mem.cards.get(p.card_id);
    if (c) picks[sideOf(p.seat_id)].push(c);
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
  const mine = (obs.your_roster ?? []).map(byId).filter(Boolean) as Card[];
  const theirs = (obs.opponent_roster ?? []).map(byId).filter(Boolean) as Card[];
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
