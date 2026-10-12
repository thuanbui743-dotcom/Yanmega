// Gemini Best: Drafter's draftPick & teamPreview + Battler's chooseAction.
import type { Bot } from '../../../src/types';
import drafter from '../drafter/index';
import battler from '../battler/index';

export default (): Bot => {
  const d = drafter(), b = battler();
  return {
    name: 'gemini/best',
    draftPick: v => d.draftPick(v),
    teamPreview: v => d.teamPreview(v),
    chooseAction: v => b.chooseAction(v),
  };
};
