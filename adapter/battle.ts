// Battle phase: platform doubles observation -> arena BattleView -> bot choice -> platform doubles_turn action.
// The observation carries Showdown's full protocol_log, so state comes from the arena's own Tracker.
import { Dex } from 'pokemon-showdown';
import type { Bot, Card } from '../src/types';
import { Tracker } from '../src/state';
import { MatchMemory, toID, cardFromObserved } from './convert';

const camel = (s: string) => String(s ?? '').toLowerCase().replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const speciesName = (e: any) => { const s = Dex.species.get(e?.species ?? e?.name ?? ''); return s.exists ? s.name : String(e?.name ?? e?.species ?? ''); };

function condition(e: any): string {
  if (!e || e.fainted || String(e.status ?? '').toUpperCase() === 'FNT' || e.current_hp === 0) return '0 fnt';
  const st = e.status ? ' ' + String(e.status).toLowerCase() : '';
  return `${e.current_hp}/${e.max_hp}${st}`;
}

/** Builds a Showdown-style request (the shape src/lib/choices.ts and the battler read) from the observation. */
export function buildRequest(obs: any, side: 'p1' | 'p2') {
  const team: Record<string, any> = obs.team ?? {};
  const entries = Object.values(team) as any[];
  const switches: any[][] = obs.available_switches ?? [[], []];
  const switchIds = new Set(switches.flat().map((s: any) => toID(s?.species ?? s?.name ?? s)));
  const active: any[] = obs.active_pokemon ?? [null, null];
  const forced: boolean[] = obs.force_switch ?? [false, false];

  // Showdown order: slot 0 and slot 1 first (a fainted or empty slot keeps a fainted placeholder), then the bench.
  const used = new Set<any>();
  const slotMon = (i: number) => {
    const a = active[i];
    let e = a ? entries.find(x => toID(x.species) === toID(a.species) && !used.has(x)) : undefined;
    if (!e) e = entries.find(x => x.active && (x.fainted || x.current_hp === 0) && !used.has(x));
    if (e) used.add(e);
    return e;
  };
  const s0 = slotMon(0), s1 = slotMon(1);
  const bench = entries.filter(e => !used.has(e) && (switchIds.has(toID(e.species)) || e.revealed || e.fainted || e.current_hp === 0));
  const mk = (e: any, isActive: boolean, slot: number) => e ? {
    ident: `${side}: ${e.name ?? speciesName(e)}`, details: `${speciesName(e)}, L50`, condition: condition(e),
    active: isActive, moves: e.moves ?? [], item: e.item ?? '', ability: e.ability ?? '',
    reviving: forced[slot] && (switches[slot] ?? []).some((s: any) => { const t = entries.find(x => toID(x.species) === toID(s?.species ?? s)); return t && (t.fainted || t.current_hp === 0); }),
  } : { ident: `${side}: empty${slot}`, details: 'Pikachu, L50', condition: '0 fnt', active: true, moves: [] };
  const pokemon = [mk(s0, true, 0), mk(s1, true, 1), ...bench.map(e => mk(e, false, -1))];

  const req: any = { side: { name: side, id: side, pokemon } };
  if (forced.some(Boolean)) {
    req.forceSwitch = forced;
  } else {
    req.active = [0, 1].map(i => ({
      moves: ((obs.available_moves ?? [])[i] ?? []).map((m: any) => ({
        move: Dex.moves.get(m.id).exists ? Dex.moves.get(m.id).name : m.id, id: m.id,
        target: camel(m.target), pp: m.current_pp, maxpp: m.max_pp, disabled: false,
      })),
      trapped: !(switches[i] ?? []).length,
    }));
  }
  return req;
}

/** The arena choice string ("move 1 2, switch 3") as a platform doubles_turn action, checked against the template. */
export function toPlatformAction(choice: string, req: any, template: any) {
  const slots: any[] = [...(template?.slots ?? [])].sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0));
  const parts = choice.split(',').map(s => s.trim());
  const out: any = {};
  let taken: string | null = null;
  slots.forEach((slot, i) => {
    const opts: any[] = slot.options ?? [];
    const [kind, a, b] = (parts[i] ?? '').split(/\s+/);
    let pick: any = null;
    if (kind === 'move') {
      const m = req.active?.[i]?.moves?.[Number(a) - 1];
      const opt = m && opts.find(o => o.type === 'move' && toID(o.move_id) === toID(m.id));
      if (opt) {
        const targets: number[] = opt.targets ?? [];
        const want = b !== undefined ? Number(b) : 0;
        const target = targets.includes(want) ? want : targets.includes(0) ? 0 : (targets.find(t => t > 0) ?? targets[0]);
        pick = { type: 'move', move_id: opt.move_id, ...(target !== undefined ? { target } : {}) };
      }
    } else if (kind === 'switch') {
      const mon = req.side.pokemon[Number(a) - 1];
      const sp = mon ? toID(mon.details.split(',')[0]) : '';
      const opt = opts.find(o => o.type === 'switch' && (toID(o.species) === sp || toID(o.species) === toID(mon?.ident?.split(': ')[1])));
      if (opt && opt.species !== taken) { pick = { type: 'switch', species: opt.species }; taken = opt.species; }
    } else if (kind === 'pass' && opts.some(o => o.type === 'pass')) {
      pick = { type: 'pass' };
    }
    if (!pick) throw new Error(`slot ${i}: could not map "${parts[i]}"`);
    out[`slot_${slot.slot ?? i}`] = pick;
  });
  if (Object.values(out).every((p: any) => p.type === 'pass')) throw new Error('both slots pass');
  return { type: 'doubles_turn', ...out };
}

function ensureTeams(obs: any, mem: MatchMemory) {
  const build = (team: Record<string, any>): Card[] => Object.values(team ?? {}).map((e: any) => {
    const known = [...mem.cards.values()].find(c => toID(c.species) === toID(e.species));
    return known ?? cardFromObserved(e);
  });
  if (mem.myTeam.length !== 6) mem.myTeam = build(obs.team);
  if (mem.oppTeam.length < 4) mem.oppTeam = build(obs.opponent_team);
}

/**
 * The platform sometimes sends the "No pending decision" placeholder observation together with a valid
 * doubles_turn template (the state changed while it was read). Rebuild the board from the last full
 * observation of this match plus the template, which carries the current actives, their HP and every option.
 */
function boardFromTemplate(template: any, last: any): any {
  const slots: any[] = [...(template.slots ?? [])].sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0));
  const team: Record<string, any> = JSON.parse(JSON.stringify(last.team ?? {}));
  for (const s of slots) {
    const a = s.active;
    if (!a) continue;
    const e = Object.values(team).find((x: any) => toID(x.species) === toID(a.species));
    if (e) Object.assign(e, { current_hp: a.current_hp, max_hp: a.max_hp, status: a.status, boosts: a.boosts, fainted: a.fainted, active: true });
  }
  return {
    ...last,
    team,
    active_pokemon: slots.map(s => s.active ?? null),
    force_switch: slots.map(s => !!s.force_switch),
    available_moves: slots.map(s => (s.options ?? []).filter((o: any) => o.type === 'move').map((o: any) => {
      const d = Dex.moves.get(o.move_id);
      // Same UPPER_SNAKE form the platform uses (e.g. ALL_ADJACENT_FOES), which buildRequest converts back.
      const target = (d.exists ? d.target : 'normal').replace(/([A-Z])/g, '_$1').toUpperCase();
      return { id: o.move_id, target, current_pp: o.current_pp, max_pp: o.current_pp, targets: o.targets };
    })),
    available_switches: slots.map(s => (s.options ?? []).filter((o: any) => o.type === 'switch').map((o: any) => ({ species: o.species }))),
  };
}

export async function battleDecision(bot: Bot, st: any, mem: MatchMemory): Promise<any> {
  const template = st.legal_actions?.actions?.[0]?.input?.action;
  if (!template || template.type !== 'doubles_turn') throw new Error('no doubles_turn template');
  let obs = st.observation ?? {};
  if (obs.team) mem.lastBattleObs = obs;
  else if (mem.lastBattleObs) obs = boardFromTemplate(template, mem.lastBattleObs);
  else throw new Error('placeholder observation and no earlier board in this match');
  const firstKey = Object.keys(obs.team ?? {})[0] ?? 'p1: ?';
  const side = (firstKey.slice(0, 2) === 'p2' ? 'p2' : 'p1') as 'p1' | 'p2';
  ensureTeams(obs, mem);
  const tracker = new Tracker(side, mem.myTeam, mem.oppTeam);
  for (const line of obs.protocol_log ?? []) { try { tracker.ingest(line); } catch { /* keep going */ } }
  const req = buildRequest(obs, side);
  tracker.syncRequest(req);
  const left = obs.clock?.decision_seconds_left;
  const choice = await bot.chooseAction({
    request: req, state: tracker.state, myTeam: mem.myTeam, oppTeam: mem.oppTeam,
    deadlineMs: typeof left === 'number' ? Math.max(5000, (left - 10) * 1000) : 30000,
  });
  if (!choice || choice === 'default') throw new Error('bot gave no choice');
  return toPlatformAction(choice, req, template);
}
