// Claude draft specialist: simulator-driven draft and Team Preview; battles with the greedy baseline.
import type { Bot } from '../../../src/types';
import { greedyBot } from '../../../src/bots/greedy';
import { choosePreview } from './preview';
import { chooseDraft } from './draft';

export default (): Bot => {
  const g = greedyBot();
  return {
    name: 'claude/drafter',
    draftPick: v => (process.env.DR_OFF ? g.draftPick(v) : chooseDraft(v)),
    teamPreview: v => choosePreview(v.myTeam, v.oppTeam),
    chooseAction: v => g.chooseAction(v),
  };
};
