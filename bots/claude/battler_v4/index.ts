// Claude battler: one-turn simulation over a payoff table (my joint actions x predicted opponent joint actions).
// Draft and Team Preview delegate to greedy so league results measure battle skill only.
import type { Bot, BattleView, Card, MonState } from '../../../src/types';
import { greedyBot } from '../../../src/bots/greedy';
import { chooseBattleAction } from './engine';

export default (): Bot => {
  const g = greedyBot();
  return {
    name: 'claude-battler',
    draftPick: v => g.draftPick(v),
    teamPreview: v => g.teamPreview(v),
    chooseAction: v => {
      try {
        return chooseBattleAction(v);
      } catch (e) {
        if (process.env.BATTLER_DEBUG) console.error(e);
        return g.chooseAction(v);
      }
    },
  };
};
export type { BattleView, Card, MonState };
