# Mac session: counter-pick-aware drafter

Paste everything below the line into Antigravity on the Mac (workspace: ~/vgc, after `git pull origin main`).

---

You are improving the DRAFT of a Pokémon VGC draft-tournament bot. The repo is ~/vgc: TypeScript, run with `npx tsx`. Read README.md and ARENA.md first, then src/types.ts, src/lib/pool.ts, src/lib/oracle.ts, src/draft.ts, and the current best drafter in bots/claude/drafter/ (draft.ts, model.ts, preview.ts).

**The problem.** In live tournament testing, the current drafter twice built teams with stacked type weaknesses, and both lost to the seat that took the counters:
- Archaludon, Dragonite, Arcanine, Salamence, Garchomp, Thundurus (3 Pokémon at 4x Ice weakness) lost to a team with Chien-Pao and Baxcalibur (Ice attackers).
- Archaludon, Rillaboom, Landorus-T, Arcanine, Dragonite, Wo-Chien (2 at 4x Ice) lost to a team with Baxcalibur and Iron Bundle.

The drafter's playouts assume the opponent drafts by raw card strength, not by countering us. Its Team Preview doesn't specifically avoid bringing several Pokémon with the same 4x weakness into a team with that attack type.

**Goal.** Build `bots/gemini2/drafter_cp/index.ts` (registered as `gemini2/drafter_cp`) with counter-pick awareness. Start from a copy of bots/claude/drafter. Ideas:
- **Shared-weakness penalty during the draft,** scaled by how many attackers of that type the opponent already has or can still legally take from the remaining pool (Item Clause applies: `legalFor` in src/draft.ts). Use real damage from `moveDamage`/`bestDamage`, not just type labels.
- **Opponent model in playouts that counter-picks:** the opponent prefers cards that hit our current team hard.
- **Denial:** take the card that would counter our core before the opponent can.
- **Team Preview:** avoid bringing 2+ Pokémon with a 4x weakness to the opponent's main attacking types.

Its `chooseAction` must delegate to the Claude battler (`import battler from '../../claude/battler/index'`), so results measure drafting only.

**Measure** (use up to 8 workers on this Mac, always with `VGC_CARDS=bss`, which matches the real tournament cards):
- `VGC_CARDS=bss npx tsx scripts/league.ts --games 300 --bots gemini2/drafter_cp,claude/best --workers 8 --logs 0`
- Also report how often each bot drafts a team with 2+ Pokémon sharing a 4x weakness. Use `results.jsonl` picks with `data/cards-bss.json`.

Keep a change only if it beats claude/best by at least 53% over 600 matches.

**Rules**
- Only write inside `bots/gemini2/drafter_cp/`.
- Do not edit `src/`, `scripts/`, `bots/claude/` or `bots/final/`.
- Draft picks must stay under 3 s and Team Preview under 5 s.

**Hard time limit: 75 minutes.** The code freeze is tonight. Then report the win rate (with game count), the stacked-weakness rates, and what helped.
