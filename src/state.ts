// Tracks battle state from the Showdown protocol as one player sees it.
import type { BattleState, Card, MonState } from './types';

function parseIdent(ident: string) {
  const m = /^(p[12])([ab]?): (.*)$/.exec(ident.trim());
  if (!m) return null;
  return { side: m[1] as 'p1' | 'p2', slot: m[2] === 'a' ? 0 : m[2] === 'b' ? 1 : -1, name: m[3] };
}

function parseCondition(cond: string | undefined): Partial<{ hpPct: number; status: string; fainted: boolean }> {
  if (!cond) return {};
  const [hp, status = ''] = cond.trim().split(' ');
  if (hp === '0' || status === 'fnt') return { hpPct: 0, status: '', fainted: true };
  const [cur, max] = hp.split('/').map(Number);
  return { hpPct: max ? (cur / max) * 100 : 0, status, fainted: false };
}

export class Tracker {
  state: BattleState;
  private oppSide: 'p1' | 'p2';
  constructor(mySide: 'p1' | 'p2', private myTeam: Card[], private oppTeam: Card[]) {
    this.oppSide = mySide === 'p1' ? 'p2' : 'p1';
    this.state = {
      mySide, my: [], opp: [], log: [],
      field: { turn: 0, weather: '', terrain: '', trickRoom: 0, tailwind: { me: 0, opp: 0 }, screens: { me: [], opp: [] } },
    };
  }

  private mon(side: 'p1' | 'p2', name: string, species?: string): MonState {
    const list = side === this.state.mySide ? this.state.my : this.state.opp;
    let m = list.find(x => x.ident.endsWith(': ' + name));
    if (!m) {
      const roster = side === this.state.mySide ? this.myTeam : this.oppTeam;
      const sp = species ?? name;
      m = {
        ident: `${side}: ${name}`, species: sp,
        card: roster.find(c => c.species === sp || c.species === name),
        hpPct: 100, status: '', boosts: {}, fainted: false, active: false, slot: -1,
        protectedLastTurn: false, turnsOnField: 0, itemConsumed: false,
      };
      list.push(m);
    }
    return m;
  }

  private byIdent(ident: string): MonState | null {
    const p = parseIdent(ident);
    return p ? this.mon(p.side, p.name) : null;
  }

  ingest(line: string) {
    if (!line.startsWith('|')) return;
    this.state.log.push(line);
    const parts = line.slice(1).split('|');
    const [cmd, a, b, c] = parts;
    const f = this.state.field;
    const mine = (s: string) => s.startsWith(this.state.mySide);
    switch (cmd) {
      case 'turn': {
        f.turn = Number(a);
        if (f.trickRoom > 0) f.trickRoom--;
        if (f.tailwind.me > 0) f.tailwind.me--;
        if (f.tailwind.opp > 0) f.tailwind.opp--;
        for (const m of [...this.state.my, ...this.state.opp]) {
          if (m.active) m.turnsOnField++;
          m.protectedLastTurn = m.lastMove === 'Protect' || m.lastMove === 'Detect' || m.lastMove === 'Spiky Shield'
            || m.lastMove === 'Baneful Bunker' || m.lastMove === 'Silk Trap' || m.lastMove === 'Burning Bulwark';
          if (!m.active) m.lastMove = undefined;
        }
        break;
      }
      case 'switch': case 'drag': case 'replace': {
        const p = parseIdent(a); if (!p) break;
        const species = b.split(',')[0];
        const list = p.side === this.state.mySide ? this.state.my : this.state.opp;
        for (const o of list) if (o.active && o.slot === p.slot) { o.active = false; o.slot = -1; o.boosts = {}; }
        const m = this.mon(p.side, p.name, species);
        m.active = true; m.slot = p.slot; m.turnsOnField = 0; m.boosts = {}; m.lastMove = undefined;
        Object.assign(m, parseCondition(c));
        break;
      }
      case 'detailschange': case '-formechange': {
        const m = this.byIdent(a); if (m) m.species = b.split(',')[0];
        break;
      }
      case 'move': { const m = this.byIdent(a); if (m) m.lastMove = b; break; }
      case '-damage': case '-heal': case '-sethp': {
        const m = this.byIdent(a); if (m) Object.assign(m, parseCondition(b)); break;
      }
      case 'faint': { const m = this.byIdent(a); if (m) { m.fainted = true; m.hpPct = 0; } break; }
      case '-status': { const m = this.byIdent(a); if (m) m.status = b; break; }
      case '-curestatus': { const m = this.byIdent(a); if (m) m.status = ''; break; }
      case '-boost': case '-unboost': {
        const m = this.byIdent(a); if (!m) break;
        const k = b as keyof MonState['boosts'];
        const d = Number(c) * (cmd === '-boost' ? 1 : -1);
        m.boosts[k] = Math.max(-6, Math.min(6, (m.boosts[k] ?? 0) + d));
        break;
      }
      case '-clearboost': case '-clearallboost': {
        if (cmd === '-clearallboost') for (const m of [...this.state.my, ...this.state.opp]) m.boosts = {};
        else { const m = this.byIdent(a); if (m) m.boosts = {}; }
        break;
      }
      case '-enditem': { const m = this.byIdent(a); if (m) m.itemConsumed = true; break; }
      case '-weather': f.weather = a === 'none' ? '' : a; break;
      case '-fieldstart':
        if (a.includes('Trick Room')) f.trickRoom = 5;
        else if (a.includes('Terrain')) f.terrain = a.replace('move: ', '');
        break;
      case '-fieldend':
        if (a.includes('Trick Room')) f.trickRoom = 0;
        else if (a.includes('Terrain')) f.terrain = '';
        break;
      case '-sidestart': case '-sideend': {
        const isMe = mine(a);
        const what = b.replace('move: ', '');
        if (what === 'Tailwind') {
          if (isMe) f.tailwind.me = cmd === '-sidestart' ? 4 : 0;
          else f.tailwind.opp = cmd === '-sidestart' ? 4 : 0;
        } else {
          const list = isMe ? f.screens.me : f.screens.opp;
          if (cmd === '-sidestart') list.push(what);
          else list.splice(list.indexOf(what) >>> 0, 1);
        }
        break;
      }
    }
  }

  /** Own side: the request has exact HP and the authoritative active list. */
  syncRequest(req: any) {
    if (!req?.side?.pokemon) return;
    req.side.pokemon.forEach((p: any) => {
      const name = p.ident.split(': ')[1];
      const m = this.mon(this.state.mySide, name, p.details.split(',')[0]);
      Object.assign(m, parseCondition(p.condition));
      m.active = !!p.active;
      if (!m.active) m.slot = -1;
    });
    let slot = 0;
    for (const p of req.side.pokemon) if (p.active) { const m = this.mon(this.state.mySide, p.ident.split(': ')[1]); m.slot = slot++; }
  }
}
