import type { Bot } from '../types';
import { slotOptions, jointChoices } from '../lib/choices';

const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)];

export const randomBot = (): Bot => ({
  name: 'random',
  draftPick: v => pick(v.legal).id,
  teamPreview: () => {
    const idx = [0, 1, 2, 3, 4, 5].sort(() => Math.random() - 0.5);
    return { order: idx.slice(0, 4) };
  },
  chooseAction: v => {
    const joint = jointChoices(slotOptions(v.request));
    // Prefer moves over switches so random games end.
    const moves = joint.filter(j => j.parts.every(p => p.kind !== 'switch'));
    return pick(moves.length ? moves : joint).choice;
  },
});
