# Dragonfly: VGC draft tournament bot

A bot for `pokemon_vgc_doubles_draft`:
- **Draft:** a shared 18-card pool, snake order A B B A A B B A A B B A, with the Item Clause.
- **Team Preview:** bring 4 of 6.
- **Battle:** Gen 9 doubles, level 50, no Terastallization.

The repo also holds a local arena that plays thousands of complete matches (draft, preview, battle) in Showdown's simulator to measure and tune bots.

## The tournament bot
**`bots/final/bot`** is what we submit.
- **Engines:** frozen copies of the current best drafter (`bots/final/drafter`) and battler (`bots/final/battler`).
- **Settings:** it clears every tuning environment variable before loading, so the host machine can't change how it plays.
- **Time guards:** hard limits of 8 s per draft pick, 30 s for Team Preview and 15 s per battle decision, against the platform's 15 s, 85 s and 50 s. On a timeout or error it falls back to a legal greedy choice.
- **Refresh:** after a proven improvement in `bots/claude/drafter` or `bots/claude/battler`, run `bash scripts/freeze.sh`.

Interface (`src/types.ts`): `draftPick(view) -> cardId`, `teamPreview(view) -> { order: [4 indices, leads first] }`, `chooseAction(view) -> Showdown choice string`.

## How it plays
- **Drafter** (`bots/claude/drafter`): for each candidate card, plays out the rest of the snake draft with a fast battle simulator (about 30 µs per game) that mimics our battler. It scores the final rosters as simulation result + 0.5 × the predictor's log-odds, and mixes in worst-case opponent replies.
- **Team Preview:** plays all 180 of our bring and lead orders against the opponent's 90.
- **Battler** (`bots/claude/battler`), each turn:
  - plays our joint actions against the opponent's likely replies in a one-turn simulator (priority, Trick Room, Tailwind, Scarf, Protect, items, abilities), then looks 2 turns ahead with bench replacements;
  - scores three damage-roll cases;
  - predicts the opponent with two models (smart and greedy-style), weighted by Bayesian trust that updates on every observed move.

  It averages about 40 ms per decision.
- **Win-rate predictor** (`src/lib/oracle.ts`, `data/oracle.json`): a logistic model over about 25 team features. It predicts 69.8% of held-out battler games and is well calibrated.

## Results (600+ matches unless noted, zero invalid choices and zero timeouts throughout)

| Matchup | Result |
|---|---|
| claude/best vs greedy | 93% |
| claude/best vs battler with greedy draft | 66% (the draft adds this much) |
| claude/best vs gemini/best (Round 1, 300) | 56% (59% drafting first, 53% second) |
| Claude battling vs Gemini battling, same drafts | 58 to 62% |
| Battler v6 vs greedy / v4 / Gemini battling | 79.3% / 49% / 59% |
| Competitive card pool (`VGC_CARDS=bss`), best vs greedy | 85% |
| Edge-case stress pools (Ditto, Illusion, Commander, two-turn moves...) | 0 crashes, 0 invalid |

**Tested and rejected** (no measurable gain): rule-of-two preview penalty, risk mode by game state, accuracy preference when ahead, double-Protect penalty.

## Layout
```
src/              arena (shared, neutral): cards, draft, battle runner, state tracker, registry
src/lib/          pool.ts (damage calc with 16-roll distributions, modifiers, KO chance), choices.ts (legal moves),
                  features.ts + oracle.ts (win-rate predictor)
src/bots/         baselines: random, greedy, randdraft, oracle
bots/claude/      Claude team: drafter (v4), battler (v6), best, datagen; drafter_v3 and battler_v4 kept for rollback
bots/gemini/      Gemini team bots
bots/final/       the tournament bot (frozen)
scripts/          league.ts, worker.ts, train-oracle.ts, stress.ts, smoke.ts, freeze.sh
data/             cards.json (2,097 random-doubles sets), cards-bss.json (364 competitive sets), oracle.json
```
Older experiment versions are under the git tag `archive-before-cleanup`.

## Commands
```
npx tsx scripts/league.ts --games 300 --bots final/bot,gemini/best,greedy --workers 12   # league
npx tsx scripts/league.ts --games 300 --bots "claude/drafter|greedy,greedy"               # X|Y = X's draft + preview, Y's battling
VGC_CARDS=bss npx tsx scripts/league.ts ...                                               # competitive card pool
npx tsx scripts/stress.ts --games 120 --bots final/bot,greedy                             # edge-case stress test
npx tsx scripts/train-oracle.ts --bots "claude/datagen,claude/datagen|claude/datagen"     # retrain predictor
bash scripts/freeze.sh                                                                    # snapshot engines into bots/final
```
League runs write `data/runs/<time>/` with results, a summary and logs of each bot's worst losses.

## Not done yet
- **Tournament platform adapter.** Needs the platform's docs: how draft, Team Preview and battle messages arrive. It will wrap `bots/final/bot`.
- **Field-simulator bot** (`bots/gemini2/field`, being built on the Mac). A model of a typical competitor, for exploit tuning.
