// Replays captured platform states through adapter/bridge.ts and checks every answer against the
// platform's own action template. Usage: npx tsx adapter/replay-captures.ts <captures dir>
import { spawn } from 'child_process';
import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';

const toID = (s: string) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

function check(phase: string, st: any, action: any): string | null {
  const tmpl = st.legal_actions?.actions?.[0]?.input?.action;
  if (phase === 'draft') {
    const ok = st.legal_actions.actions.some((a: any) => a.input?.action?.card_id === action?.card_id);
    return ok ? null : `card ${action?.card_id} not legal`;
  }
  if (phase === 'team_preview') {
    const roster = (tmpl?.roster ?? []).map(toID);
    if (new Set(action.bring).size !== 4 || !action.bring.every((s: string) => roster.includes(toID(s)))) return 'bad bring';
    if (action.leads.length !== 2 || !action.leads.every((s: string) => action.bring.includes(s))) return 'bad leads';
    return null;
  }
  if (phase === 'moving') {
    if (action?.type !== 'doubles_turn') return 'not doubles_turn';
    for (const slot of tmpl.slots) {
      const a = action[`slot_${slot.slot}`];
      const opts = slot.options;
      if (!a) return `slot ${slot.slot} missing`;
      if (a.type === 'pass' && !opts.some((o: any) => o.type === 'pass')) return `slot ${slot.slot} pass not offered`;
      if (a.type === 'switch' && !opts.some((o: any) => o.type === 'switch' && o.species === a.species)) return `slot ${slot.slot} bad switch`;
      if (a.type === 'move') {
        const o = opts.find((o: any) => o.type === 'move' && o.move_id === a.move_id);
        if (!o) return `slot ${slot.slot} move ${a.move_id} not offered`;
        if ((o.targets ?? []).length && !o.targets.includes(a.target)) return `slot ${slot.slot} target ${a.target} not in ${o.targets}`;
      }
    }
    if (action.slot_0?.type === 'switch' && action.slot_1?.type === 'switch' && action.slot_0.species === action.slot_1.species) return 'double switch';
    return null;
  }
  return 'unknown phase';
}

(async () => {
  const dir = process.argv[2];
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();
  const child = spawn(process.execPath, ['--import', 'tsx', path.join(__dirname, 'bridge.ts')], { cwd: path.join(__dirname, '..') });
  const rl = readline.createInterface({ input: child.stdout! });
  const q: any[] = []; let wake: (() => void) | null = null;
  rl.on('line', l => { q.push(JSON.parse(l)); wake?.(); });
  const next = () => new Promise<any>(res => { const go = () => (q.length ? res(q.shift()) : (wake = go)); go(); });
  await next();
  let ok = 0, bad = 0, id = 0;
  for (const f of files) {
    const cap = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const st = cap.state, phase = st.phase;
    if (!st.legal_actions?.actions?.length) continue;
    const t = Date.now();
    child.stdin!.write(JSON.stringify({ id: ++id, agent_id: cap.context.agent_id, phase, state: st }) + '\n');
    const r = await next();
    const problem = r.error ? `bridge error: ${r.error}` : check(phase, st, r.action);
    if (problem) bad++; else ok++;
    console.log(`${f} ${phase} ${Date.now() - t} ms ${problem ? 'FAIL ' + problem : 'ok ' + JSON.stringify(r.action).slice(0, 110)}`);
  }
  console.log(`\n${ok} ok, ${bad} failed`);
  child.kill();
})();
