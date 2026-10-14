// Long-running simulation harness: alternates tournament evaluation and datagen self-play
// on competitive cards (VGC_CARDS=bss) until a specified time (default: 21:00 today).
// Periodically logs progress and retrains data/oracle.json upon completion.
//
// Usage: npx tsx scripts/sim-until-9pm.ts [--until 21:00] [--workers 12]
import { fork, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import type { MatchResult } from '../src/match';

process.env.VGC_CARDS = 'bss';

const args = process.argv.slice(2);
const arg = (k: string, d: string) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const untilStr = arg('until', '21:00');
const numWorkers = Number(arg('workers', '12'));

const [targetHour, targetMin] = untilStr.split(':').map(Number);
const deadline = new Date();
deadline.setHours(targetHour, targetMin, 0, 0);

if (deadline.getTime() <= Date.now()) {
  console.log(`Target deadline ${untilStr} has already passed for today.`);
  process.exit(0);
}

const remainingMins = ((deadline.getTime() - Date.now()) / 60000).toFixed(1);
console.log(`Starting continuous simulation until ${untilStr} (~${remainingMins} minutes) using ${numWorkers} workers.`);

const runDir = path.join(__dirname, '..', 'data', 'runs', `${new Date().toISOString().replace(/[:.]/g, '-')}-sim-until-9pm`);
fs.mkdirSync(runDir, { recursive: true });
const outStream = fs.createWriteStream(path.join(runDir, 'results.jsonl'), { flags: 'a' });

interface Task {
  seed: number;
  a: string;
  b: string;
  keepLog: boolean;
  type: 'tournament' | 'datagen';
}

const queue: Task[] = [];
let seedCounter = Math.floor(Date.now() % 1e8);

const TOURNEY_BOTS = ['final/bot', 'gemini2/drafter_cp', 'gemini/best', 'gemini2/field', 'gemini2/llmlike'];

function enqueueBatch() {
  // 1. Tournament evaluation matches (5 key competitors against each other)
  for (let i = 0; i < TOURNEY_BOTS.length; i++) {
    for (let j = i + 1; j < TOURNEY_BOTS.length; j++) {
      for (let g = 0; g < 4; g++) {
        const s = seedCounter++;
        queue.push({ seed: s, a: TOURNEY_BOTS[i], b: TOURNEY_BOTS[j], keepLog: false, type: 'tournament' });
        queue.push({ seed: s, a: TOURNEY_BOTS[j], b: TOURNEY_BOTS[i], keepLog: false, type: 'tournament' });
      }
    }
  }
  // 2. Datagen self-play matches for oracle training (mirror matches)
  for (let g = 0; g < 40; g++) {
    const s = seedCounter++;
    queue.push({ seed: s, a: 'claude/datagen', b: 'claude/datagen|claude/datagen', keepLog: false, type: 'datagen' });
    queue.push({ seed: s, a: 'claude/datagen|claude/datagen', b: 'claude/datagen', keepLog: false, type: 'datagen' });
  }
}

const allResults: MatchResult[] = [];
const t0 = Date.now();
let lastReportTime = Date.now();

function printProgress() {
  const elapsedSec = (Date.now() - t0) / 1000;
  const leftMins = Math.max(0, (deadline.getTime() - Date.now()) / 60000).toFixed(1);
  const tourneyResults = allResults.filter(r => TOURNEY_BOTS.includes(r.sides.A) && TOURNEY_BOTS.includes(r.sides.B));
  const datagenResults = allResults.filter(r => r.sides.A.includes('datagen'));

  console.log(`\n--- [${new Date().toLocaleTimeString()}] Progress Update (${leftMins}m remaining, ${allResults.length} matches total) ---`);
  console.log(`Tournament matches: ${tourneyResults.length} | Datagen training matches: ${datagenResults.length}`);

  // Summary table for tournament bots
  const rows = TOURNEY_BOTS.map(b => {
    const mine = tourneyResults.filter(r => r.sides.A === b || r.sides.B === b);
    const w = mine.filter(r => r.winner === b).length;
    const t = mine.filter(r => r.winner === 'tie').length;
    return {
      bot: b,
      games: mine.length,
      winPct: +(100 * (w + t / 2) / Math.max(1, mine.length)).toFixed(1),
    };
  }).sort((x, y) => y.winPct - x.winPct);
  console.table(rows);

  // Head-to-head for final/bot
  const fbVs: Record<string, string> = {};
  for (const opp of TOURNEY_BOTS) {
    if (opp === 'final/bot') continue;
    const m = tourneyResults.filter(r => (r.sides.A === 'final/bot' && r.sides.B === opp) || (r.sides.A === opp && r.sides.B === 'final/bot'));
    const w = m.filter(r => r.winner === 'final/bot').length;
    const pct = m.length ? ((100 * w) / m.length).toFixed(1) + '%' : 'N/A';
    fbVs[opp] = `${w}/${m.length} (${pct})`;
  }
  console.log('final/bot vs opponents:');
  console.table([fbVs]);

  // Write interim summary
  fs.writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify({
    totalMatches: allResults.length,
    tourneyMatches: tourneyResults.length,
    datagenMatches: datagenResults.length,
    elapsedMinutes: +(elapsedSec / 60).toFixed(1),
    rows,
  }, null, 2));
}

let activeWorkers = 0;
const workers: { child: ChildProcess; busy: boolean }[] = [];

function spawnWorker() {
  const child = fork(path.join(__dirname, 'worker.ts'), [], {
    execArgv: ['--import', 'tsx'],
    env: { ...process.env, VGC_CARDS: 'bss' },
  });
  const workerObj = { child, busy: false };
  workers.push(workerObj);
  activeWorkers++;

  child.on('message', (r: MatchResult) => {
    allResults.push(r);
    outStream.write(JSON.stringify(r) + '\n');
    workerObj.busy = false;

    // Report every 15 minutes or every 500 matches
    if (Date.now() - lastReportTime > 15 * 60 * 1000 || allResults.length % 500 === 0) {
      lastReportTime = Date.now();
      printProgress();
    }

    dispatch();
  });

  child.on('exit', () => {
    activeWorkers--;
    const idx = workers.indexOf(workerObj);
    if (idx >= 0) workers.splice(idx, 1);
    if (Date.now() < deadline.getTime()) {
      spawnWorker();
      dispatch();
    } else if (activeWorkers === 0) {
      finalize();
    }
  });

  return workerObj;
}

function dispatch() {
  if (Date.now() >= deadline.getTime()) {
    // Deadline reached: tell workers to exit
    for (const w of workers) {
      if (!w.busy) {
        w.busy = true;
        try { w.child.send('exit'); } catch {}
      }
    }
    return;
  }

  // Refill queue if running low
  if (queue.length < numWorkers * 4) {
    enqueueBatch();
  }

  for (const w of workers) {
    if (!w.busy && queue.length > 0) {
      w.busy = true;
      const task = queue.shift()!;
      w.child.send(task);
    }
  }
}

// Initial spawn
for (let i = 0; i < numWorkers; i++) {
  spawnWorker();
}
enqueueBatch();
dispatch();

function finalize() {
  outStream.end();
  console.log(`\n=== 9:00 PM Deadline reached! Finalizing run ===`);
  printProgress();

  console.log('\nRetraining oracle predictor with accumulated datagen data...');
  try {
    execSync('npx tsx scripts/train-oracle.ts --bots "randdraft,randdraft2,claude/datagen,claude/datagen|claude/datagen"', {
      stdio: 'inherit',
      cwd: path.join(__dirname, '..'),
    });
    console.log('Oracle predictor successfully retrained!');
  } catch (e: any) {
    console.error('Error retraining oracle:', e?.message ?? e);
  }

  console.log(`\nAll done! Results saved in ${runDir}`);
  process.exit(0);
}

process.on('SIGINT', () => {
  console.log('\nInterrupted by user. Exiting gracefully...');
  for (const w of workers) {
    try { w.child.send('exit'); } catch {}
  }
  finalize();
});
