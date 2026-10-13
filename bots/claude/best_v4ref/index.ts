// Reference: the previously frozen drafter (v4) + current battler, for validating newer drafters.
import type { Bot } from '../../../src/types';
import drafter from '../drafter_v4ref/index';
import battler from '../battler/index';
export default (): Bot => { const d = drafter(), b = battler(); return { name: 'claude/best_v4ref', draftPick: v => d.draftPick(v), teamPreview: v => d.teamPreview(v), chooseAction: v => b.chooseAction(v) }; };
