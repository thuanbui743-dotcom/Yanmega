// Bot registry. Built-in baselines plus auto-discovered team bots:
//   bots/<team>/<name>/index.ts  with  `export default (): Bot => ...`
// Registered as "<team>/<name>".
import * as fs from 'fs';
import * as path from 'path';
import type { Bot } from './types';
import { randomBot } from './bots/random';
import { greedyBot } from './bots/greedy';
import { randDraftBot } from './bots/randdraft';
import { oracleBot } from './bots/oracle';

const builtins: Record<string, () => Bot> = { random: randomBot, greedy: greedyBot, randdraft: randDraftBot, randdraft2: randDraftBot, oracle: () => oracleBot() };

export function listBots(): string[] {
  const root = path.join(__dirname, '..', 'bots');
  const found: string[] = [];
  if (fs.existsSync(root)) {
    for (const team of fs.readdirSync(root)) {
      const td = path.join(root, team);
      if (!fs.statSync(td).isDirectory()) continue;
      for (const name of fs.readdirSync(td)) {
        if (fs.existsSync(path.join(td, name, 'index.ts'))) found.push(`${team}/${name}`);
      }
    }
  }
  return [...Object.keys(builtins), ...found];
}

export function makeBot(id: string): Bot {
  // "X|Y" = draft + Team Preview from X, battle from Y. Isolates draft skill from battle skill.
  if (id.includes('|')) {
    const [d, b] = id.split('|').map(makeBot);
    return { name: id, draftPick: v => d.draftPick(v), teamPreview: v => d.teamPreview(v), chooseAction: v => b.chooseAction(v) };
  }
  let bot: Bot;
  if (builtins[id]) bot = builtins[id]();
  else {
    const mod = require(path.join(__dirname, '..', 'bots', id, 'index.ts'));
    const factory = mod.default ?? mod.bot ?? mod;
    bot = factory();
  }
  return { ...bot, name: id };
}
