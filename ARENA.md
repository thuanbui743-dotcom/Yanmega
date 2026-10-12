# VGC Draft Arena: team brief

You are building a bot for a Pokémon VGC **draft** tournament. Your bot competes in this local arena against the other team's bots. Highest league win rate wins. **Drafting matters as much as battling.**

## The format
- **Pool and draft:** a shared, random pool of 18 cards. Each card is a fixed set: species, item, ability, nature, EVs and moves, all at level 50.
- **Snake order:** A B B A A B B A A B B A, 6 cards each. A also plays as p1 in battle.
- **Item Clause:** your 6 must hold 6 different items. The arena only offers legal cards (`view.legal`).
- **Information:** everything is public, including both rosters and every card's full set.
- **Team Preview:** bring 4 of 6. The first two you list lead.
- **Battle:** Gen 9 doubles, 4v4, no Terastallization. Opponent HP is shown as a percentage; your own HP is exact.
- **Time limits:** 15 s per draft pick and 50 s per battle decision. Missing one means a random pick or move. Aim for under 1 s per decision so the league can play thousands of games.

## Rules for teams
- Your code lives in `bots/<team>/<botname>/index.ts`, with `export default (): Bot => ({ ... })`. The registry finds it automatically as `<team>/<botname>`.
- **Do not edit** anything in `src/` or `scripts/`. They are the shared arena. You may read and import from them (`src/lib/pool.ts`, `src/lib/choices.ts`, `src/types.ts`).
- Build every battle choice from `slotOptions(request)` / `jointChoices(...)` in `src/lib/choices.ts` so it is always legal. An invalid choice counts against you.
- No network calls during games.
- You may keep several versions (`bots/<team>/v1`, `v2`, ...). Keep your best one named `bots/<team>/best`.

## Useful library (src/lib/pool.ts)
- `analyzePool(cards)`: for every pair of cards, the best average damage % (`dmg[i][j]`), the 1v1 result (`win[i][j]`), Speed (`spe`) and overall `power`. Use it to plan the draft around the actual pool.
- `moveDamage(att, def, move, mods)`: the damage calculator with boosts, weather, terrain and current HP. Returns min/max/avg % of HP, plus whether the move is a spread move or hits your ally.
- `speed(card)` (includes Choice Scarf), `oneVsOne(a, b)`, `bestDamage(a, b)`.
- The battle view gives `state` (actives, HP %, boosts, status, field: Trick Room / Tailwind turns, weather, terrain), the raw `request`, and `myTeam` / `oppTeam` with full sets.

## Commands
```
npx tsx scripts/league.ts --games 200 --bots <team>/best,greedy,random
npx tsx scripts/league.ts --games 200 --bots "<team>/best|greedy,greedy"   # your draft + greedy battling vs greedy
```
- **`X|Y` ids:** the bot drafts and picks its team like X and battles like Y. Use these to measure draft skill and battle skill separately.
- **Output:** each run writes `data/runs/<time>/` with `results.jsonl`, `summary.json` and full logs of your worst losses (`losses/`). Read the losses.

## Baselines to beat
- `random`
- `greedy`: drafts by 1v1 pool power, brings its 4 best, attacks for max expected damage. It beats random 99% of the time.

## What is known to work (research)
- Deterministic engines beat LLM-driven play in doubles. In the VGC-Bench study, an LLM playing on its own won only 18 to 25% against a simple rule-based bot.
- **Simultaneous turns:** build a small payoff table each turn (your top joint actions × their likely actions) and choose the best worst case or a mixed strategy.
- **KO tables:** turns-to-KO from the known sets. Count a KO only if the minimum roll kills.
- **Speed order:** priority moves, Trick Room, Tailwind, Choice Scarf.
- **Team Preview by brute force:** 15 possible brings × 6 lead pairs, scored against the opponent's likely 4.
- **Draft:** value what a card adds to *your* team, plus what it would deny the opponent. The opponent picks twice in a row, so plan around that. Speed control, Fake Out, Intimidate and redirection all matter in doubles.

## League rounds
The lead runs a league across all teams' `best` bots every few hours. After each round, both teams receive the summary and the loss logs. You may copy any idea you see work.
