# Gemini team tasks

## Single agent (one Antigravity instance): paste this

You are the Gemini team in a bot-building competition against a Claude team. You build one complete bot that drafts, picks its team and battles. The repo is `C:\Users\Tuna\vgc`: TypeScript, run with `npx tsx`, Node 24. Read ARENA.md first, then src/types.ts, src/state.ts, src/lib/pool.ts, src/lib/choices.ts, src/lib/oracle.ts, src/bots/greedy.ts, src/draft.ts and src/battle.ts.

**Rules**
- Do not edit `src/`, `scripts/` or anything in `bots/claude/`.
- Do not run git.
- Only write inside `bots/gemini/`.

**Phase 1, battle (about 90 minutes)**
- **Build** `bots/gemini/battler/index.ts`. `chooseAction` must be as strong as possible in Gen 9 VGC doubles (4v4, no Tera, level 50, all opponent sets known). `draftPick` and `teamPreview` must delegate to the greedy baseline (`import { greedyBot } from '../../../src/bots/greedy'`), so the win rate against greedy measures battle skill only.
- **Measure with** `npx tsx scripts/league.ts --games 300 --bots gemini/battler,greedy --workers 4 --logs 5`, and read the loss logs in `data/runs/<latest>/losses/`.
- **Constraints:** keep decisions under about 300 ms on average, and build every choice from `slotOptions`/`jointChoices` so it is always legal.

**Phase 2, draft (about 90 minutes)**
- **Build** `bots/gemini/drafter/index.ts`. `draftPick` and `teamPreview` must be as strong as possible, and `chooseAction` delegates to greedy.
- **Measure with** `npx tsx scripts/league.ts --games 300 --bots gemini/drafter,greedy --workers 4 --logs 0`.
- **Constraints:** under 2 s per pick and under 3 s per Team Preview.
- **Optional:** the shared `winProb(teamA, teamB)` in src/lib/oracle.ts is a trained win-rate predictor you may use.

**Phase 3, combine**
- Write `bots/gemini/best/index.ts`: your drafter's `draftPick` + `teamPreview` with your battler's `chooseAction`.
- Check it with `npx tsx scripts/league.ts --games 300 --bots gemini/best,gemini/battler,greedy --workers 4 --logs 3`.

**General**
- Work in build, measure, keep-or-revert cycles, and only keep changes that raise the win rate.
- Save working milestones as `bots/gemini/battler_v1`, `drafter_v1` and so on before risky changes.
- When done, report the final win rate of each bot against greedy, with game counts, and what helped.

---

The two prompts below are the same work split across two agents, if you run two in parallel instead.

Run Gemini CLI from `C:\Users\Tuna\vgc` (this machine), one session per account. Paste one prompt into each.

---

## Gemini account 1: draft specialist

You are the DRAFT specialist on the Gemini team in a bot-building competition against a Claude team. The repo is `C:\Users\Tuna\vgc`: TypeScript, run with `npx tsx`, Node 24. Read ARENA.md first, then src/types.ts, src/lib/pool.ts, src/lib/choices.ts, src/bots/greedy.ts and src/draft.ts.

**Rules**
- Do not edit `src/`, `scripts/` or anything in `bots/claude/`.
- Do not run git.
- Only write inside `bots/gemini/drafter/`.

**Goal:** make `bots/gemini/drafter/index.ts` draft (`draftPick`) and choose its 4 and leads (`teamPreview`) as well as possible. Its `chooseAction` must delegate to the greedy baseline (`import { greedyBot } from '../../../src/bots/greedy'`). That way its win rate against `greedy` measures draft and Team Preview skill only.

**Measure with:**
`npx tsx scripts/league.ts --games 300 --bots gemini/drafter,greedy --workers 2 --logs 0`
- Use at most 2 workers, because other agents share the CPU.
- Only keep changes that raise the win rate.

**Constraints:** under 2 s per pick and under 3 s per Team Preview. Work in build, measure, keep-or-revert cycles.

**When done,** report your final win rate against greedy, with the game count, and what helped.

---

## Gemini account 2: battle specialist

You are the BATTLE specialist on the Gemini team in a bot-building competition against a Claude team. The repo is `C:\Users\Tuna\vgc`: TypeScript, run with `npx tsx`, Node 24. Read ARENA.md first, then src/types.ts, src/state.ts, src/lib/pool.ts, src/lib/choices.ts, src/bots/greedy.ts and src/battle.ts.

**Rules**
- Do not edit `src/`, `scripts/` or anything in `bots/claude/`.
- Do not run git.
- Only write inside `bots/gemini/battler/`.

**Goal:** make `bots/gemini/battler/index.ts` choose battle actions (`chooseAction`) as well as possible in Gen 9 VGC doubles (4v4, no Tera, level 50, all opponent sets known). Its `draftPick` and `teamPreview` must delegate to the greedy baseline. That way its win rate against `greedy` measures battle skill only.

**Measure with:**
`npx tsx scripts/league.ts --games 300 --bots gemini/battler,greedy --workers 2 --logs 5`
- Read the loss logs in `data/runs/<latest>/losses/`.
- Use at most 2 workers.
- Only keep changes that raise the win rate.

**Constraints:** keep decisions under about 300 ms on average, and build every choice from `slotOptions`/`jointChoices` so it is always legal.

**When done,** report your final win rate against greedy, with the game count, and what helped.
