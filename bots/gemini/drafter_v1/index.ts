// Gemini Drafter: Simulator & oracle-driven draft and Team Preview; battles with greedy baseline.
import type { Bot } from '../../../src/types';
import { greedyBot } from '../../../src/bots/greedy';
import { choosePreview } from './preview';
import { chooseDraft } from './draft';

export default (): Bot => {
  const g = greedyBot();
  return {
    name: 'gemini/drafter',
    draftPick: v => chooseDraft(v),
    teamPreview: v => choosePreview(v.myTeam, v.oppTeam),
    chooseAction: v => g.chooseAction(v),
  };
};
