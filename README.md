# Dragonfly: VGC draft tournament bot

A bot for `pokemon_vgc_doubles_draft`:
- **Draft:** a shared 18-card pool, snake order A B B A A B B A A B B A, with the Item Clause.
- **Team Preview:** bring 4 of 6.
- **Battle:** Gen 9 doubles, level 50, no Terastallization.

The repo also holds a local arena that plays thousands of complete matches (draft, preview, battle) in Showdown's simulator to measure and tune bots.

## Running on the AltruAgent platform (UCLA Agent Tournament)
Dragonfly is a **self-hosted** agent. The official starter ([altruagent-starter](https://github.com/UCLA-Trustworthy-AI-Lab/altruagent-starter), tested at commit `951f4f74b008c6aa7f40bec09e741aa67d3c45cc`) handles everything platform-side: signing in with the Official Agent Key, finding assignments, seat grants, lease renewal and MCP play. It loads our agent, `runtime/dragonfly_agent.py`.

**Requirements:** Node.js 22+ (tested on 24), Python 3.11+, git.

**Setup (once, Windows):**
```
git clone <this repo> vgc
cd vgc && npm install && cd ..
mkdir vgc-ext && cd vgc-ext
git clone https://github.com/UCLA-Trustworthy-AI-Lab/altruagent-starter.git starter
cd starter && git checkout 951f4f74b008c6aa7f40bec09e741aa67d3c45cc
python -m venv .venv && .venv\Scripts\python -m pip install -e .
copy .env.example .env      (then set ALTRUAGENT_OFFICIAL_AGENT_KEY in .env; never commit it)
```

**Run:**
```
vgc\runtime\run-agent.bat                   (tournament and Testing games, restarts automatically)
powershell -File vgc\runtime\run-agent.ps1 -Mode tournament -Starter <path to starter>
```
Equivalent manual command, from the starter folder: `set PYTHONPATH=<vgc>\runtime` then `.venv\Scripts\python -m agent --tournament --match --agent dragonfly_agent`. Check the setup first with `--check-tournament`.

**How a game flows:**
- The starter creates one `DragonflyAgent` per match, in that match's own process, so every match starts with fresh memory.
- The agent starts one Node process, `adapter/bridge.ts`, which runs the frozen engine `bots/final/bot`.
- Each decision is one JSON line each way.
- The bridge converts platform observations into the engine's views:
  - **Draft:** cards become our `Card` type.
  - **Team Preview:** species ids are resolved to the drafted cards.
  - **Battle:** the observation's full Showdown `protocol_log` feeds the same battle tracker the engine was tuned on, and a Showdown-style request is built from the board.
- The engine's answer becomes a platform action (`draft_pick`, `select_lineup`, `doubles_turn`), checked against the platform's legal options before it is sent.
- **Fallback:** if the bridge is slow (budgets of 11 s per pick, 40 s for preview and 30 s per turn) or fails, the agent sends a simple legal move instead.
- **Logs:** decisions go to `logs/bridge-*.log`, our own observations to `logs/states/`, and runtime output to `logs/runtime-*.log` (all git-ignored).

## Components (Official Rules, section 8)
- **No language model and no external services.** All decisions are made by deterministic code in this repo: search, simulation and scoring. Nothing is sent anywhere except the platform's own MCP and control-plane endpoints, by the official starter.
- **Code:** `adapter/` (platform bridge), `runtime/` (starter agent and launcher), `bots/final/` (the tournament engine: a frozen drafter and battler), `src/` (shared library: battle tracker, damage calculation, legal moves, win-rate predictor).
- **Dependencies:** `pokemon-showdown` (data and simulator library), `@smogon/calc` (damage calculator), `tsx` (TypeScript runner), and the official `altruagent-starter` (Python).
- **Fixed reference data, built before the Submission Deadline:**
  - `data/oracle.json`: win-rate predictor weights, trained offline on our own simulated games.
  - `data/cards-bss.json` and `data/cards.json`: Showdown set libraries.
  - `data/platform-cards.json`: platform card sets recorded during Testing. It is used only to fill in a card the draft view does not show in full.

  Nothing is learned or stored across matches during the tournament.
- **No prompts, no human input during matches.** The rest of the repo (`bots/claude`, `bots/gemini`, `bots/gemini2`, `scripts/`) is the development and testing arena: other bot versions, baselines and tools. It is not used in tournament play.

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
  - predicts the opponent with three models (smart, greedy-style and rule-follower), weighted by Bayesian trust that updates on every observed move.

  It averages about 40 ms per decision.
- **Win-rate predictor** (`src/lib/oracle.ts`, `data/oracle.json`): a logistic model over about 25 team features. It predicts 69.8% of held-out battler games and is well calibrated.

## Results (600+ matches unless noted, zero invalid choices and zero timeouts throughout)

| Matchup | Result |
|---|---|
| **final/bot** (drafter v10 + battler v7) vs gemini/best / field bot / llmlike / greedy | **59% / 85% / 93% / 100%** |
| final/bot vs gemini/best (`VGC_CARDS=bss`, 100 matches) | 59% (64% drafting first) |
| claude/best_v10 vs gemini/best (`VGC_CARDS=bss`, 200 matches) | 59% (66% drafting first) |
| final/bot vs claude/best (baseline) | 52.5% vs 47.5% |
| Stacked 4x type weaknesses | Reduced from 15.8% -> 2.5% |
| claude/best vs greedy | 93% |
| claude/best vs battler with greedy draft | 66% (the draft adds this much) |
| Claude battling vs Gemini battling, same drafts | 58 to 62% |
| Battler v6 vs greedy / v4 / Gemini battling | 79.3% / 49% / 59% |
| Edge-case stress pools (Ditto, Illusion, Commander, two-turn moves...) | 0 crashes, 0 invalid |
| Revival Blessing regression tests (40 battles, 10 revivals) | 0 crashes, 0 invalid |

**Tested and rejected** (no measurable gain): rule-of-two preview penalty, risk mode by game state, accuracy preference when ahead, double-Protect penalty, switch-risk costs (measured: switch reads are right about 72% of the time and save about 20% HP), endgame draft minimax.

**Live platform:** Testing matches played end to end through the adapter with zero errors and zero fallbacks. Draft picks take under 2 s, Team Preview about 1 s, and battle turns under 120 ms.

## Layout
```
src/              arena (shared, neutral): cards, draft, battle runner, state tracker, registry
src/lib/          pool.ts (damage calc with 16-roll distributions, modifiers, KO chance), choices.ts (legal moves),
                  features.ts + oracle.ts (win-rate predictor)
src/bots/         baselines: random, greedy, randdraft, oracle
adapter/          platform bridge (bridge.ts, convert.ts, battle.ts), replay and catalog tools
runtime/          dragonfly_agent.py (loaded by the official starter), run-agent.ps1/.bat (launcher with restarts)
bots/final/       the tournament bot (frozen)
bots/claude/      Claude team: drafter (v4), battler (v7, plus disabled experiment options), best, datagen; rollbacks
bots/gemini/      Gemini team bots; bots/gemini2/field: model of a typical competitor
scripts/          league.ts, worker.ts, train-oracle.ts, stress.ts, smoke.ts, revival-test.ts, freeze.sh
data/             cards.json (2,097 random-doubles sets), cards-bss.json (364 competitive sets), oracle.json, platform-cards.json
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

## Adapter tests
```
npx tsx adapter/test-bridge.ts                          # full draft + Team Preview through the bridge, synthetic platform states
npx tsx adapter/replay-captures.ts <captured states dir> # replays recorded platform states, checks every answer against the template
npx tsx adapter/catalog.ts <captured states dir>        # adds recorded platform cards to data/platform-cards.json
```
