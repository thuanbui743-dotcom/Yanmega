// Claude team best: drafter's draft + Team Preview, battler's battle engine.
import type { Bot } from '../../../src/types';
import drafter from '../drafter_v9/index';
import battler from '../battler/index';

export default (): Bot => {
  const d = drafter(), b = battler();
  return {
    name: 'claude/best_v9',
    draftPick: v => d.draftPick(v),
    teamPreview: v => d.teamPreview(v),
    chooseAction: v => b.chooseAction(v),
  };
};
