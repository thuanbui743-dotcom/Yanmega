// Data generator for the predictor: random draft, greedy Team Preview and battle.
import type { Bot } from '../types';
import { greedyBot } from './greedy';

export const randDraftBot = (): Bot => {
  const g = greedyBot();
  return { ...g, name: 'randdraft', draftPick: v => v.legal[Math.floor(Math.random() * v.legal.length)].id };
};
