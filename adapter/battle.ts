// Battle phase: platform doubles observation -> arena BattleView -> bot choice -> platform doubles_turn action.
// Filled in once real observations are captured (field names must match the live platform).
import type { Bot } from '../src/types';
import type { MatchMemory } from './convert';

export async function battleDecision(_bot: Bot, _state: any, _mem: MatchMemory): Promise<any> {
  throw new Error('battle mapping not implemented yet');
}
