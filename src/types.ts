// Shared contract between the arena and every bot. Teams must not change this file.

export interface StatsTable { hp: number; atk: number; def: number; spa: number; spd: number; spe: number }

/** A fixed, pre-built set. Bots see every card's full details. */
export interface Card {
  id: string;          // unique within the card library
  species: string;
  item: string;
  ability: string;
  nature: string;
  evs: StatsTable;
  ivs: StatsTable;
  moves: string[];     // display names, e.g. "Fake Out"
  level: number;       // always 50
}

export type Side = 'A' | 'B';

export interface DraftView {
  me: Side;
  pool: Card[];                    // all 18 cards
  picks: Record<Side, Card[]>;     // picks so far, in order
  order: Side[];                   // full snake order, e.g. A B B A A B B A A B B A
  pickIndex: number;               // index into order for this pick (0-based)
  available: Card[];               // undrafted cards
  legal: Card[];                   // cards I may take now (Item Clause applied)
  oppLegal: Card[];                // cards the opponent may currently take
}

export interface PreviewView {
  me: Side;
  myTeam: Card[];
  oppTeam: Card[];
}

/** 4 indices into myTeam. The first two lead. */
export interface PreviewChoice { order: number[] }

export interface MonState {
  ident: string;           // e.g. "p2a: Garchomp"
  species: string;
  card?: Card;             // resolved from the roster when known
  hpPct: number;           // 0..100 (exact for own side via request, rounded % for opponent)
  status: string;          // '', 'brn', 'par', 'slp', 'frz', 'psn', 'tox'
  boosts: Partial<Record<'atk' | 'def' | 'spa' | 'spd' | 'spe' | 'accuracy' | 'evasion', number>>;
  fainted: boolean;
  active: boolean;
  slot: number;            // 0 or 1 when active, -1 otherwise
  lastMove?: string;
  protectedLastTurn: boolean;
  turnsOnField: number;
  itemConsumed: boolean;
}

export interface FieldState {
  turn: number;
  weather: string;
  terrain: string;
  trickRoom: number;       // turns left, 0 if inactive
  tailwind: { me: number; opp: number };
  screens: { me: string[]; opp: string[] };
}

export interface BattleState {
  mySide: 'p1' | 'p2';
  my: MonState[];          // my brought mons
  opp: MonState[];         // opponent mons revealed so far
  field: FieldState;
  log: string[];           // raw protocol lines so far
}

export interface BattleView {
  request: any;            // raw Showdown request JSON (the source of truth for legality)
  state: BattleState;
  myTeam: Card[];          // my 6
  oppTeam: Card[];         // their 6 (full sets known)
  deadlineMs: number;      // time allowed for this decision
}

export interface Bot {
  name: string;
  draftPick(view: DraftView): string | Promise<string>;              // returns card id
  teamPreview(view: PreviewView): PreviewChoice | Promise<PreviewChoice>;
  chooseAction(view: BattleView): string | Promise<string>;          // Showdown choice string, e.g. "move 1 2, move 3 -1"
}
