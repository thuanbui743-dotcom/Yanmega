// Decision bridge for one match. Reads one JSON request per line on stdin, writes one JSON reply per line.
//   request: {"id": n, "agent_id": "...", "phase": "draft"|"team_preview"|"moving", "state": <raw platform state>}
//   reply:   {"id": n, "action": {...platform play_action action...}} or {"id": n, "error": "..."}
// The Python agent falls back to a simple legal move on any error or timeout.
import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import type { Bot, PreviewChoice } from '../src/types';
import { makeBot } from '../src/registry';
import { MatchMemory, draftView, resolveRosters, lineupFromOrder, previewView } from './convert';
import { battleDecision } from './battle';

const bot: Bot = makeBot('final/bot');
const mem = new MatchMemory();

async function handle(req: any): Promise<any> {
  mem.myAgentId = req.agent_id || mem.myAgentId;
  const st = req.state ?? {};
  const obs = st.observation ?? {};
  const actions: any[] = st.legal_actions?.actions ?? [];
  switch (req.phase) {
    case 'draft': {
      const legalIds = actions.map(a => a?.input?.action?.card_id ?? String(a?.action_id ?? '').replace(/^draft_pick:/, '')).filter(Boolean);
      const view = draftView(obs, mem, legalIds);
      const id = await bot.draftPick(view);
      const card = view.legal.find(c => c.id === id) ?? view.legal[0];
      return { type: 'draft_pick', card_id: card.id };
    }
    case 'team_preview': {
      resolveRosters(obs, mem);
      const roster: string[] = actions[0]?.input?.action?.roster ?? (obs.your_roster ?? []).map((r: any) => r.species);
      if (mem.myTeam.length !== 6 || mem.oppTeam.length !== 6) throw new Error('rosters not resolved');
      const choice = (await bot.teamPreview(previewView(mem))) as PreviewChoice;
      return lineupFromOrder(choice.order, mem.myTeam, roster);
    }
    case 'moving':
      return battleDecision(bot, st, mem);
    default:
      throw new Error(`unsupported phase ${req.phase}`);
  }
}

// Decision log on stderr (the Python agent writes it to logs/<session>-<agent>.log).
const log = (msg: string) => process.stderr.write(`${new Date().toISOString()} ${msg}\n`);

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async line => {
  let req: any;
  try { req = JSON.parse(line); } catch { return; }
  const t0 = Date.now();
  const turn = req.state?.observation?.turn ?? req.state?.observation?.pick_number ?? '';
  // Keep our own observations for offline debugging (logs/states/<pid>/<n>-<phase>.json).
  try {
    const dir = path.join(__dirname, '..', 'logs', 'states', String(process.pid));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${String(req.id).padStart(3, '0')}-${req.phase}.json`),
      JSON.stringify({ context: { agent_id: req.agent_id }, state: req.state }));
  } catch { /* logging must never block a decision */ }
  try {
    const action = await handle(req);
    log(`${req.phase} ${turn} ${Date.now() - t0}ms ${JSON.stringify(action)}`);
    process.stdout.write(JSON.stringify({ id: req.id, action }) + '\n');
  } catch (e: any) {
    log(`${req.phase} ${turn} ${Date.now() - t0}ms ERROR ${String(e?.stack ?? e).split('\n').slice(0, 3).join(' | ')}`);
    process.stdout.write(JSON.stringify({ id: req.id, error: String(e?.message ?? e) }) + '\n');
  }
});
process.stdout.write(JSON.stringify({ ready: true }) + '\n');
