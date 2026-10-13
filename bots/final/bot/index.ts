// Tournament bot. Frozen copies of the Claude drafter and battler (refresh with scripts/freeze.sh),
// tuning environment variables cleared, hard time budgets with legal fallbacks on every decision.
import type { Bot, PreviewChoice } from '../../../src/types';
import { greedyBot } from '../../../src/bots/greedy';
import { slotOptions, jointChoices } from '../../../src/lib/choices';

// Experiment knobs read at module load. Clear them so the host environment cannot change play.
for (const k of Object.keys(process.env)) {
  if (/^(DR_|PV_|BP_|SIM_POLICY|BATTLER_|SHOWLOG)/.test(k)) delete process.env[k];
}
// Load after clearing the environment (static imports would run first).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const drafter: () => Bot = require('../drafter/index').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const battler: () => Bot = require('../battler/index').default;

const BUDGET = { draft: 8000, preview: 30000, battle: 15000 }; // limits: 15 s, 85 s, 50 s

function race<T>(work: () => T | Promise<T>, ms: number, fallback: () => T): Promise<T> {
  return new Promise<T>(resolve => {
    let done = false;
    const finish = (v: T) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    // A throwing fallback must never escape (it would crash the process): resolve undefined instead,
    // and the platform falls back to its own default.
    const safe = () => { try { return fallback(); } catch { return undefined as unknown as T; } };
    const timer = setTimeout(() => { console.error(`[final] fallback: no answer within ${ms} ms`); finish(safe()); }, ms);
    Promise.resolve().then(work).then(finish, (e: any) => {
      console.error(`[final] fallback: ${String(e?.stack ?? e).split('\n').slice(0, 3).join(' | ')}`);
      finish(safe());
    });
  });
}

export default (): Bot => {
  const d = drafter(), b = battler(), g = greedyBot();
  const safeAction = (v: Parameters<Bot['chooseAction']>[0]) => {
    try { return g.chooseAction(v) as string; } catch { return jointChoices(slotOptions(v.request))[0].choice; }
  };
  return {
    name: 'final',
    draftPick: v => race(() => d.draftPick(v), BUDGET.draft, () => {
      try { return g.draftPick(v) as string; } catch { return v.legal[0].id; }
    }).then(id => (v.legal.some(c => c.id === id) ? id : v.legal[0].id)),
    teamPreview: v => race(() => d.teamPreview(v), BUDGET.preview, () => {
      try { return g.teamPreview(v) as PreviewChoice; } catch { return { order: [0, 1, 2, 3] }; }
    }),
    chooseAction: v => race(() => b.chooseAction(v), BUDGET.battle, () => safeAction(v)),
  };
};
