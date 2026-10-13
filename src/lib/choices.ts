// Enumerates legal per-slot options from a Showdown request and combines them into valid choice strings.
// Every bot should build its answer from these so it never sends an invalid choice.

export interface SlotOption {
  kind: 'move' | 'switch' | 'pass';
  choice: string;          // e.g. "move 2 1", "switch 3", "pass"
  move?: string;           // move display name
  moveId?: string;
  targetType?: string;
  target?: number;         // 1/2 = foe slots, -1/-2 = own slots (absent when no target needed)
  switchTo?: number;       // 1-based index into request.side.pokemon
}

const FOE_TARGETS = new Set(['normal', 'any', 'adjacentFoe']);

/** Options for each active slot. Ally targets are only offered for moves that can only target an ally. */
export function slotOptions(req: any): SlotOption[][] {
  const side = req.side.pokemon as any[];
  const benchSwitches = side
    .map((p, i) => ({ p, i: i + 1 }))
    .filter(({ p }) => !p.active && !p.condition.endsWith(' fnt') && p.condition !== '0 fnt');

  if (req.forceSwitch) {
    // Revival Blessing: the slot's Pokémon is flagged `reviving` and must pick a fainted party member.
    const fainted = side
      .map((p, i) => ({ p, i: i + 1 }))
      .filter(({ p }) => !p.active && (p.condition.endsWith(' fnt') || p.condition === '0 fnt'));
    return (req.forceSwitch as boolean[]).map((need, slot) => {
      if (!need) return [{ kind: 'pass' as const, choice: 'pass' }];
      const pool = side[slot]?.reviving ? fainted : benchSwitches;
      const opts = pool.map(({ i }) => ({ kind: 'switch' as const, choice: `switch ${i}`, switchTo: i }));
      return opts.length ? opts : [{ kind: 'pass' as const, choice: 'pass' }];
    });
  }
  if (!req.active) return [];

  return (req.active as any[]).map((act, slot) => {
    const mon = side[slot];
    if (!mon || mon.condition.endsWith(' fnt') || act.commanding) return [{ kind: 'pass' as const, choice: 'pass' }];
    const opts: SlotOption[] = [];
    act.moves.forEach((m: any, j: number) => {
      if (m.disabled || (m.pp !== undefined && m.pp <= 0 && !m.maxpp)) return;
      const base = { kind: 'move' as const, move: m.move, moveId: m.id, targetType: m.target };
      const allyPos = slot === 0 ? -2 : -1;
      if (FOE_TARGETS.has(m.target)) {
        for (const t of [1, 2]) opts.push({ ...base, choice: `move ${j + 1} ${t}`, target: t });
      } else if (m.target === 'adjacentAlly') {
        opts.push({ ...base, choice: `move ${j + 1} ${allyPos}`, target: allyPos });
      } else if (m.target === 'adjacentAllyOrSelf') {
        opts.push({ ...base, choice: `move ${j + 1} ${allyPos}`, target: allyPos });
        opts.push({ ...base, choice: `move ${j + 1} ${slot === 0 ? -1 : -2}`, target: slot === 0 ? -1 : -2 });
      } else {
        opts.push({ ...base, choice: `move ${j + 1}` });
      }
    });
    if (!act.trapped && !act.maybeTrapped) {
      for (const { i } of benchSwitches) opts.push({ kind: 'switch', choice: `switch ${i}`, switchTo: i });
    }
    if (!opts.length) opts.push({ kind: 'move', choice: 'move 1' }); // Struggle / recharge
    return opts;
  });
}

/** All valid joint choices (no double switch into the same mon). */
export function jointChoices(opts: SlotOption[][]): { choice: string; parts: SlotOption[] }[] {
  if (opts.length === 0) return [{ choice: 'default', parts: [] }];
  if (opts.some(o => o.length === 0)) opts = opts.map(o => (o.length ? o : [{ kind: 'pass' as const, choice: 'pass' }]));
  if (opts.length === 1) return opts[0].map(o => ({ choice: o.choice, parts: [o] }));
  const out: { choice: string; parts: SlotOption[] }[] = [];
  for (const a of opts[0]) for (const b of opts[1]) {
    if (a.switchTo && a.switchTo === b.switchTo) continue;
    out.push({ choice: `${a.choice}, ${b.choice}`, parts: [a, b] });
  }
  // Force switch with only one bench mon: the second slot must pass.
  if (!out.length) out.push({ choice: `${opts[0][0].choice}, pass`, parts: [opts[0][0]] });
  return out;
}

export function joinChoice(parts: SlotOption[]): string {
  return parts.map(p => p.choice).join(', ');
}
