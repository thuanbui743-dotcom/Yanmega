import type { Bot } from '../../../src/types';
import { choosePreview } from './preview';
import { chooseDraft } from './draft';
import battler from '../../claude/battler/index';

export default (): Bot => {
  const b = battler();
  return {
    name: 'gemini2/drafter_cp',
    draftPick: v => chooseDraft(v),
    teamPreview: v => choosePreview(v.myTeam, v.oppTeam),
    chooseAction: v => b.chooseAction(v),
  };
};
