// Gemini Battler: delegates draftPick and teamPreview to greedy, uses Gemini engine for battle actions.
import type { Bot, BattleView } from '../../../src/types';
import { greedyBot } from '../../../src/bots/greedy';
import { chooseBattleAction } from './engine';

export default (): Bot => {
  const g = greedyBot();
  return {
    name: 'gemini/battler',
    draftPick: v => g.draftPick(v),
    teamPreview: v => g.teamPreview(v),
    chooseAction: v => {
      try {
        return chooseBattleAction(v);
      } catch (err) {
        return g.chooseAction(v);
      }
    },
  };
};
