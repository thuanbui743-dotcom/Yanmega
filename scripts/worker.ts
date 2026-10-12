import { playMatch } from '../src/match';
import { makeBot } from '../src/registry';

process.on('message', async (t: any) => {
  if (t === 'exit') process.exit(0);
  try {
    const r = await playMatch(t.seed, makeBot(t.a), makeBot(t.b), { keepLog: t.keepLog });
    process.send!(r);
  } catch (e: any) {
    process.send!({ seed: t.seed, sides: { A: t.a, B: t.b }, winner: 'tie', error: String(e?.stack ?? e),
      battle: { invalid: { p1: 0, p2: 0 }, timeouts: { p1: 0, p2: 0 }, turns: 0 }, draftTimeouts: 0 });
  }
});
