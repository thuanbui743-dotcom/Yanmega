// Data generator: random draft, Claude drafter's Team Preview, Claude battler's battling.
// Mirror matches of this bot measure team strength under our real battle engine.
import type { Bot } from '../../../src/types';
import drafter from '../drafter/index';
import battler from '../battler/index';

export default (): Bot => {
  const d = drafter(), b = battler();
  return {
    name: 'claude/datagen',
    draftPick: v => v.legal[Math.floor(Math.random() * v.legal.length)].id,
    teamPreview: v => d.teamPreview(v),
    chooseAction: v => b.chooseAction(v),
  };
};
