// Fast pool model + deterministic 4v4 doubles simulator used for Team Preview and draft evaluation.
// The simulator plays both sides with a greedy "max expected damage" policy using precomputed damage tables.
import { Dex } from 'pokemon-showdown';
import type { Card } from '../../../src/types';
import { moveDamage, speed } from '../../../src/lib/pool';

export interface MoveInfo {
  name: string;
  status: boolean;
  spread: boolean;      // hits both foes
  hitsAlly: boolean;
  randomTarget: boolean;
  single: boolean;      // needs a foe target
  priority: number;
  acc: number;          // 0..1
  physical: boolean;
  defStat: 'def' | 'spd';
  fakeOut: boolean;
  protect: boolean;
  drain: number;        // fraction healed
  recoil: number;
  selfBoosts: [number, number, number, number, number]; // atk def spa spd spe
  tgtBoosts: [number, number, number, number, number] | null;
}

export interface CardInfo {
  card: Card;
  spe: number;
  moves: MoveInfo[];
  sash: boolean; choice: boolean; lifeOrb: boolean; sitrus: boolean; lefties: boolean;
  intimidate: boolean; intimidateImmune: boolean;
  tailwind: boolean; trickRoom: boolean; redirect: boolean; fakeOut: boolean; protect: boolean;
  speedCtl: boolean; // Icy Wind, Electroweb, Thunder Wave
  weather: string; terrain: string; // set on entry
}

/** Damage tables under one field condition: avg[i*4+k][j], min[i*4+k][j]. */
export interface Table { avg: Float64Array[]; min: Float64Array[] }

export interface Model {
  n: number;
  cards: Card[];
  idx: Map<string, number>;
  info: CardInfo[];
  best: Float64Array[]; // best[i][j] = best avg % of i into j (neutral field)
  table(weather: string, terrain: string): Table;
}

const modelCache = new Map<string, Model>();

export function poolKey(pool: Card[]) { return pool.map(c => c.id).join(','); }

const WEATHER_AB: Record<string, string> = { Drought: 'SunnyDay', 'Orichalcum Pulse': 'SunnyDay', Drizzle: 'RainDance', 'Sand Stream': 'Sandstorm', 'Snow Warning': 'Snowscape' };
const TERRAIN_AB: Record<string, string> = { 'Electric Surge': 'Electric Terrain', 'Hadron Engine': 'Electric Terrain', 'Psychic Surge': 'Psychic Terrain', 'Grassy Surge': 'Grassy Terrain', 'Misty Surge': 'Misty Terrain' };
const STATS = ['atk', 'def', 'spa', 'spd', 'spe'] as const;
const boostVec = (b: any): [number, number, number, number, number] => STATS.map(s => (b && b[s]) || 0) as any;

export function buildModel(pool: Card[]): Model {
  const key = poolKey(pool);
  const hit = modelCache.get(key);
  if (hit) return hit;
  const n = pool.length;
  const info: CardInfo[] = pool.map(c => {
    const moves: MoveInfo[] = c.moves.map(name => {
      const dm = Dex.moves.get(name);
      const status = dm.category === 'Status';
      const sec = dm.secondary && dm.secondary.chance === 100 ? dm.secondary : null;
      return {
        name: dm.name, status,
        spread: dm.target === 'allAdjacentFoes' || dm.target === 'allAdjacent',
        hitsAlly: dm.target === 'allAdjacent',
        randomTarget: dm.target === 'randomNormal',
        single: dm.target === 'normal' || dm.target === 'any' || dm.target === 'adjacentFoe',
        priority: dm.priority,
        acc: dm.accuracy === true ? 1 : (dm.accuracy as number) / 100,
        physical: dm.category === 'Physical',
        defStat: dm.overrideDefensiveStat === 'def' || (dm.category === 'Physical' && !dm.overrideDefensiveStat) ? 'def' : 'spd',
        fakeOut: dm.id === 'fakeout',
        protect: ['protect', 'detect', 'spikyshield', 'banefulbunker', 'silktrap', 'burningbulwark', 'kingsshield'].includes(dm.id),
        drain: dm.drain ? dm.drain[0] / dm.drain[1] : 0,
        recoil: dm.recoil ? dm.recoil[0] / dm.recoil[1] : 0,
        selfBoosts: boostVec(dm.self?.boosts ?? sec?.self?.boosts),
        tgtBoosts: sec?.boosts ? boostVec(sec.boosts) : null,
      };
    });
    const has = (...ids: string[]) => moves.some(m => ids.includes(m.name));
    return {
      card: c, spe: speed(c), moves,
      sash: c.item === 'Focus Sash' || c.ability === 'Sturdy', choice: c.item.startsWith('Choice'), lifeOrb: c.item === 'Life Orb',
      sitrus: c.item === 'Sitrus Berry', lefties: c.item === 'Leftovers',
      intimidate: c.ability === 'Intimidate',
      intimidateImmune: ['Clear Body', 'White Smoke', 'Full Metal Body', 'Hyper Cutter', 'Inner Focus', 'Oblivious', 'Own Tempo', 'Scrappy', 'Mirror Armor', 'Guard Dog'].includes(c.ability) || c.item === 'Clear Amulet',
      tailwind: has('Tailwind'), trickRoom: has('Trick Room'), redirect: has('Follow Me', 'Rage Powder'),
      fakeOut: has('Fake Out'), protect: moves.some(m => m.protect),
      speedCtl: has('Icy Wind', 'Electroweb', 'Thunder Wave', 'Bleakwind Storm', 'Glare', 'Nuzzle'),
      weather: WEATHER_AB[c.ability] ?? '', terrain: TERRAIN_AB[c.ability] ?? '',
    };
  });
  const tables = new Map<string, Table>();
  const table = (weather: string, terrain: string): Table => {
    const k = weather + '|' + terrain;
    let t = tables.get(k);
    if (t) return t;
    const avg: Float64Array[] = [], min: Float64Array[] = [];
    for (let i = 0; i < n; i++) for (let mk = 0; mk < 4; mk++) {
      const a = new Float64Array(n), b = new Float64Array(n);
      const mv = info[i].moves[mk];
      if (mv && !mv.status) {
        for (let j = 0; j < n; j++) {
          if (j === i) continue;
          const d = moveDamage(pool[i], pool[j], mv.name, { weather: weather || undefined, terrain: terrain || undefined });
          if (d) { a[j] = d.avgPct; b[j] = d.minPct; }
        }
      }
      avg.push(a); min.push(b);
    }
    t = { avg, min };
    tables.set(k, t);
    return t;
  };
  const t0 = table('', '');
  const best = info.map((_, i) => {
    const row = new Float64Array(n);
    for (let k = 0; k < 4; k++) for (let j = 0; j < n; j++) if (t0.avg[i * 4 + k][j] > row[j]) row[j] = t0.avg[i * 4 + k][j];
    return row;
  });
  const model: Model = { n, cards: pool, idx: new Map(pool.map((c, i) => [c.id, i])), info, best, table };
  modelCache.set(key, model);
  if (modelCache.size > 50) modelCache.delete(modelCache.keys().next().value!);
  return model;
}

// ---------------------------------------------------------------- simulator

interface Mon {
  i: number; hp: number; st: number[]; locked: number; sash: boolean; sitrus: boolean; turns: number; protLast: boolean;
}

const stageMult = (s: number) => (s >= 0 ? (2 + s) / 2 : 2 / (2 - s));

function mkMon(m: Model, i: number): Mon {
  return { i, hp: 100, st: [0, 0, 0, 0, 0], locked: -1, sash: m.info[i].sash, sitrus: m.info[i].sitrus, turns: 0, protLast: false };
}

interface Act { mon: Mon; side: number; slot: number; move: number; tgt: number; pri: number }

export interface SimOpts { maxTurns?: number }

function applyBoosts(mon: Mon, b: number[]) {
  for (let k = 0; k < 5; k++) if (b[k]) mon.st[k] = Math.max(-6, Math.min(6, mon.st[k] + b[k]));
}

/**
 * Simulates order A (card indices; first two lead, then bench order) vs order B.
 * Returns margin in [-1, 1]: (A remaining HP - B remaining HP) / 4, with a bonus for wiping the other side.
 */
export function simulate(m: Model, A: number[], B: number[], opts: SimOpts = {}): number {
  const maxTurns = opts.maxTurns ?? 20;
  const teams: Mon[][] = [A.map(i => mkMon(m, i)), B.map(i => mkMon(m, i))];
  const act: (Mon | null)[][] = [[teams[0][0] ?? null, teams[0][1] ?? null], [teams[1][0] ?? null, teams[1][1] ?? null]];
  const next = [2, 2];
  const tw = [0, 0];
  let tr = 0;
  let weather = '', terrain = '';
  let T = m.table('', '');
  const enter = (side: number, mon: Mon) => {
    const ci = m.info[mon.i];
    if (ci.intimidate) for (const f of act[1 - side]) if (f && f.hp > 0 && !m.info[f.i].intimidateImmune) f.st[0] = Math.max(-6, f.st[0] - 1);
    if (ci.weather && ci.weather !== weather) { weather = ci.weather; T = m.table(weather, terrain); }
    if (ci.terrain && ci.terrain !== terrain) { terrain = ci.terrain; T = m.table(weather, terrain); }
  };
  // Leads enter in speed order (slower setter's weather wins).
  const leads: [number, Mon][] = [];
  for (let s = 0; s < 2; s++) for (const mon of act[s]) if (mon) leads.push([s, mon]);
  leads.sort((x, y) => m.info[y[1].i].spe - m.info[x[1].i].spe);
  for (const [s, mon] of leads) enter(s, mon);

  const mul = (att: Mon, def: Mon, mv: MoveInfo) =>
    stageMult(att.st[mv.physical ? 0 : 2]) / stageMult(def.st[mv.defStat === 'def' ? 1 : 3]);
  const effSpe = (mon: Mon, side: number) => m.info[mon.i].spe * stageMult(mon.st[4]) * (tw[side] > 0 ? 2 : 1);

  const alive = (s: number) => teams[s].some(x => x.hp > 0);
  for (let turn = 0; turn < maxTurns && alive(0) && alive(1); turn++) {
    const acts: Act[] = [];
    for (let s = 0; s < 2; s++) {
      const foes = act[1 - s];
      const opts2: { v: number; move: number; tgt: number; kill: boolean }[][] = [];
      for (let slot = 0; slot < 2; slot++) {
        const me = act[s][slot];
        const list: { v: number; move: number; tgt: number; kill: boolean }[] = [];
        if (!me || me.hp <= 0) { opts2.push([{ v: 0, move: -1, tgt: -1, kill: false }]); continue; }
        const ci = m.info[me.i];
        const ally = act[s][1 - slot];
        ci.moves.forEach((mv, k) => {
          if (me.locked >= 0 && k !== me.locked) return;
          if (mv.fakeOut) { list.push({ v: me.turns === 0 ? 45 : -50, move: k, tgt: foes[0] && foes[0].hp > 0 ? 0 : 1, kill: false }); return; }
          if (mv.status) { list.push({ v: mv.protect ? (me.protLast ? -20 : 2) : 1, move: k, tgt: -1, kill: false }); return; }
          const row = me.i * 4 + k;
          const hitv = (f: Mon | null) => {
            if (!f || f.hp <= 0) return { d: 0, kill: false };
            const x = mul(me, f, mv);
            const d = T.avg[row][f.i] * x;
            return { d: Math.min(d, f.hp), kill: T.min[row][f.i] * x >= f.hp };
          };
          if (mv.single) {
            for (let t = 0; t < 2; t++) {
              const h = hitv(foes[t]);
              list.push({ v: h.d + (h.kill ? 50 : 0), move: k, tgt: t, kill: h.kill });
            }
          } else {
            const a = hitv(foes[0]), b = hitv(foes[1]);
            let v = a.d + b.d + (a.kill ? 50 : 0) + (b.kill ? 50 : 0);
            if (mv.hitsAlly && ally && ally.hp > 0) {
              const x = mul(me, ally, mv);
              const d = Math.min(T.avg[row][ally.i] * x, ally.hp);
              v -= 1.5 * d + (T.min[row][ally.i] * x >= ally.hp ? 100 : 0);
            }
            list.push({ v: v || 1, move: k, tgt: -1, kill: false });
          }
        });
        if (!list.length) list.push({ v: 0, move: -1, tgt: -1, kill: false });
        opts2.push(list);
      }
      let bv = -Infinity, b0 = opts2[0][0], b1 = opts2[1][0];
      for (const o0 of opts2[0]) for (const o1 of opts2[1]) {
        let v = o0.v + o1.v;
        if (o0.kill && o1.kill && o0.tgt === o1.tgt) v -= 60;
        if (v > bv) { bv = v; b0 = o0; b1 = o1; }
      }
      [b0, b1].forEach((o, slot) => {
        const me = act[s][slot];
        if (!me || me.hp <= 0 || o.move < 0) return;
        acts.push({ mon: me, side: s, slot, move: o.move, tgt: o.tgt, pri: m.info[me.i].moves[o.move].priority });
      });
    }
    const flinched = new Set<Mon>();
    const protecting = new Set<Mon>();
    const done = new Set<Act>();
    // Dynamic speed order: re-evaluate after each action (speed drops apply immediately in Gen 8+).
    while (done.size < acts.length) {
      let a: Act | null = null, av = -Infinity;
      for (const x of acts) {
        if (done.has(x)) continue;
        const sp = effSpe(x.mon, x.side);
        const v = x.pri * 1e6 + (tr > 0 ? -sp : sp) + (x.side === 0 ? 0.1 : 0);
        if (v > av) { av = v; a = x; }
      }
      done.add(a!);
      const me = a!.mon;
      if (me.hp <= 0 || flinched.has(me)) { me.protLast = false; continue; }
      const ci = m.info[me.i];
      const mv = ci.moves[a!.move];
      if (ci.choice && me.locked < 0) me.locked = a!.move;
      if (mv.protect) { if (!me.protLast) protecting.add(me); me.protLast = !me.protLast; continue; }
      me.protLast = false;
      if (mv.status) {
        if (mv.name === 'Tailwind') tw[a!.side] = 4;
        else if (mv.name === 'Trick Room') tr = tr > 0 ? 0 : 4;
        continue;
      }
      const foes = act[1 - a!.side];
      let targets: Mon[] = [];
      if (mv.single) {
        let t = foes[a!.tgt];
        if (!t || t.hp <= 0) t = foes[1 - a!.tgt];
        if (t && t.hp > 0) targets = [t];
      } else if (mv.randomTarget) {
        targets = foes.filter((f): f is Mon => !!f && f.hp > 0).slice(0, 1);
      } else {
        targets = foes.filter((f): f is Mon => !!f && f.hp > 0);
        if (mv.hitsAlly) { const al = act[a!.side][1 - a!.slot]; if (al && al.hp > 0) targets.push(al); }
      }
      const row = me.i * 4 + a!.move;
      let dealt = 0;
      for (const t of targets) {
        if (protecting.has(t)) continue;
        let d = T.avg[row][t.i] * mul(me, t, mv) * mv.acc;
        if (d <= 0) continue;
        if (mv.fakeOut) flinched.add(t);
        if (t.sash && t.hp >= 100 && d >= 100) d = 99;
        if (t.hp >= 100) t.sash = false;
        const before = t.hp;
        t.hp = Math.max(0, t.hp - d);
        dealt += before - t.hp;
        if (t.sitrus && t.hp > 0 && t.hp <= 50) { t.hp += 25; t.sitrus = false; }
        if (mv.tgtBoosts && t.hp > 0) applyBoosts(t, mv.tgtBoosts);
      }
      if (dealt > 0) {
        if (ci.lifeOrb) me.hp -= 10;
        if (mv.drain) me.hp = Math.min(100, me.hp + dealt * mv.drain * 0.5);
        if (mv.recoil) me.hp -= dealt * mv.recoil * 0.5;
        if (me.hp < 0) me.hp = 0;
        applyBoosts(me, mv.selfBoosts);
      }
    }
    // End of turn.
    for (let s = 0; s < 2; s++) {
      if (tw[s] > 0) tw[s]--;
      for (let slot = 0; slot < 2; slot++) {
        const mon = act[s][slot];
        if (!mon) continue;
        if (mon.hp > 0) { mon.turns++; if (m.info[mon.i].lefties) mon.hp = Math.min(100, mon.hp + 6.25); }
        if (mon.hp <= 0) {
          const nx = next[s] < teams[s].length ? teams[s][next[s]++] : null;
          act[s][slot] = nx;
          if (nx) enter(s, nx);
        }
      }
    }
    if (tr > 0) tr--;
  }
  let sa = 0, sb = 0;
  for (const x of teams[0]) sa += Math.max(0, x.hp) / 100;
  for (const x of teams[1]) sb += Math.max(0, x.hp) / 100;
  let margin = (sa - sb) / 4;
  if (!alive(1) && alive(0)) margin = 0.25 + 0.75 * margin;
  else if (!alive(0) && alive(1)) margin = -0.25 + 0.75 * margin;
  return margin;
}

/** All bring orders for a team: 15 subsets x 6 lead pairs (bench order by index) = 90 for 6 cards. */
export function bringOrders(team: number[]): number[][] {
  const out: number[][] = [];
  const n = team.length;
  if (n <= 4) {
    for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) {
      const rest = team.filter((_, k) => k !== a && k !== b);
      out.push([team[a], team[b], ...rest]);
    }
    if (!out.length) out.push([...team]);
    return out;
  }
  const subs: number[][] = [];
  const rec = (start: number, cur: number[]) => {
    if (cur.length === 4) { subs.push(cur); return; }
    for (let k = start; k < n; k++) rec(k + 1, [...cur, team[k]]);
  };
  rec(0, []);
  for (const s of subs) for (let x = 0; x < 4; x++) for (let y = x + 1; y < 4; y++) {
    const rest = s.filter((_, k) => k !== x && k !== y);
    out.push([s[x], s[y], ...rest]);
  }
  return out;
}
