// League: every pair of bots plays N matches per seat order across worker processes.
// Usage: npx tsx scripts/league.ts [--games 200] [--workers 14] [--bots greedy,random,claude/x] [--logs 10]
import { fork } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { listBots } from '../src/registry';
import type { MatchResult } from '../src/match';

const args = process.argv.slice(2);
const arg = (k: string, d: string) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const games = Number(arg('games', '200'));
const workers = Number(arg('workers', String(Math.max(1, require('os').cpus().length - 2))));
const bots = arg('bots', listBots().join(',')).split(',').filter(Boolean);
const keepLosses = Number(arg('logs', '10'));
const seedBase = Number(arg('seed', String(Date.now() % 1e9)));

interface Task { seed: number; a: string; b: string; keepLog: boolean }
const tasks: Task[] = [];
let s = seedBase;
for (let i = 0; i < bots.length; i++) for (let j = i + 1; j < bots.length; j++) {
  for (let g = 0; g < games; g++) {
    // Same pool for both seat orders so draft position is balanced.
    const seed = s++;
    tasks.push({ seed, a: bots[i], b: bots[j], keepLog: false });
    tasks.push({ seed, a: bots[j], b: bots[i], keepLog: false });
  }
}

const runDir = path.join(__dirname, '..', 'data', 'runs', new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(runDir, { recursive: true });
const out = fs.createWriteStream(path.join(runDir, 'results.jsonl'));
const results: MatchResult[] = [];
const t0 = Date.now();
let next = 0, doneCount = 0;

function report() {
  const rows = bots.map(b => {
    const mine = results.filter(r => r.sides.A === b || r.sides.B === b);
    const w = mine.filter(r => r.winner === b).length;
    const t = mine.filter(r => r.winner === 'tie').length;
    const asA = mine.filter(r => r.sides.A === b), wA = asA.filter(r => r.winner === b).length;
    return { bot: b, games: mine.length, winPct: +(100 * (w + t / 2) / Math.max(1, mine.length)).toFixed(1), firstPickWinPct: +(100 * wA / Math.max(1, asA.length)).toFixed(1) };
  }).sort((x, y) => y.winPct - x.winPct);
  console.table(rows);
  const head: Record<string, Record<string, string>> = {};
  for (const a of bots) {
    head[a] = {};
    for (const b of bots) {
      if (a === b) { head[a][b] = '-'; continue; }
      const m = results.filter(r => (r.sides.A === a && r.sides.B === b) || (r.sides.A === b && r.sides.B === a));
      head[a][b] = m.length ? (100 * m.filter(r => r.winner === a).length / m.length).toFixed(0) + '%' : '';
    }
  }
  console.log('Row bot win % vs column bot:'); console.table(head);
  const inv = results.reduce((x, r) => x + r.battle.invalid.p1 + r.battle.invalid.p2, 0);
  const to = results.reduce((x, r) => x + r.battle.timeouts.p1 + r.battle.timeouts.p2 + r.draftTimeouts, 0);
  const firstWins = results.filter(r => r.winner === r.sides.A).length;
  console.log(`${results.length} matches in ${((Date.now() - t0) / 1000).toFixed(0)}s | first drafter wins ${(100 * firstWins / Math.max(1, results.length)).toFixed(1)}% | invalid choices ${inv} | timeouts ${to}`);
  fs.writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify({ rows, head, invalid: inv, timeouts: to }, null, 2));
  console.log(`results: ${runDir}`);
}

let active = Math.min(workers, tasks.length);
console.log(`${tasks.length} matches, ${bots.length} bots, ${workers} workers`);
for (let w = 0; w < Math.min(workers, tasks.length); w++) {
  const child = fork(path.join(__dirname, 'worker.ts'), [], { execArgv: ['--import', 'tsx'] });
  const feed = () => { if (next < tasks.length) child.send(tasks[next++]); else child.send('exit'); };
  child.on('message', (r: MatchResult) => {
    results.push(r); out.write(JSON.stringify(r) + '\n');
    if (++doneCount % 200 === 0) console.log(`${doneCount}/${tasks.length} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    feed();
  });
  child.on('exit', () => {
    if (doneCount >= tasks.length || next >= tasks.length) {
      if (--active === 0) { out.end(); report(); saveLossLogs(); }
    }
  });
  feed();
}

// Replay the worst few losses per bot with full logs for the teams to study.
async function saveLossLogs() {
  if (!keepLosses) return;
  const { playMatch } = await import('../src/match');
  const { makeBot } = await import('../src/registry');
  for (const b of bots) {
    const losses = results.filter(r => (r.sides.A === b || r.sides.B === b) && r.winner !== b && r.winner !== 'tie')
      .sort((x, y) => x.battle.turns - y.battle.turns).slice(0, keepLosses);
    const dir = path.join(runDir, 'losses', b.replace('/', '__'));
    fs.mkdirSync(dir, { recursive: true });
    for (const l of losses) {
      const r = await playMatch(l.seed, makeBot(l.sides.A), makeBot(l.sides.B), { keepLog: true });
      fs.writeFileSync(path.join(dir, `${l.seed}-${l.sides.A === b ? 'A' : 'B'}.log`), JSON.stringify({ ...r, log: undefined }) + '\n' + r.log!.join('\n'));
    }
  }
}
