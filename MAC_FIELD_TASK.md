# Mac session: field simulator bot

Paste everything below the line into Antigravity on the Mac (workspace: ~/vgc).

---

You are building a FIELD SIMULATOR bot: a faithful implementation of the strategy a typical competitor in this tournament will use. Most competitors had an AI assistant write a VGC strategy spec and turned it into deterministic rules. Your bot implements one such spec, given below, so the other teams can test their bots against "the typical field". Fidelity to the spec matters more than beating anyone. Implement it competently and bug-free, without inventing a different strategy.

The repo is ~/vgc: TypeScript, run with `npx tsx`. Read ARENA.md first, then src/types.ts, src/state.ts, src/lib/pool.ts, src/lib/choices.ts, src/bots/greedy.ts, src/draft.ts and src/battle.ts.

**Rules**
- Only write inside `bots/gemini2/`. Do not edit `src/`, `scripts/` or other teams' folders.
- Do not run git.

**Deliverable:** `bots/gemini2/field/index.ts`, with `export default (): Bot => ...`, implementing draft, Team Preview and battle per the spec.
- Build every battle choice from `slotOptions`/`jointChoices` so it is always legal.
- Use `analyzePool`, `moveDamage`, `speed` and `oneVsOne` from src/lib/pool.ts.
- Stay under 1 s per draft pick, 2 s per Team Preview and 200 ms per battle decision.

**Measure** (use up to 6 workers on this Mac):
- `npx tsx scripts/league.ts --games 200 --bots gemini2/field,greedy --workers 6 --logs 3`
- `npx tsx scripts/league.ts --games 200 --bots gemini2/field,claude/best --workers 6 --logs 5`

Read the loss logs in `data/runs/<latest>/losses/` to find bugs, meaning places where the bot does not do what the spec says. Fix bugs only; don't change the strategy. It should clearly beat greedy, since the spec is much richer than greedy. If it doesn't, something is implemented wrong. It must have zero invalid choices.

**When done,** report the win rates (with game counts), any parts of the spec you could not implement, and the 5 most common ways it loses to claude/best, from the loss logs.

## THE SPEC

### Draft: card score C(i), about 0 to 100, computed on the 18-card pool
- **Pool power, 0 to 40:** 40 × mean over the other 17 cards of `oneVsOne(i, j)`.
- **Threat, 0 to 10:** 10 × fraction of the pool i OHKOs (`bestDamage(i,j).avgPct >= 100`).
- **Bulk, 0 to 10:** 10 × fraction of the pool that cannot 2HKO i (`bestDamage(j,i).avgPct < 50`).
- **Speed, 0 to 8:** 8 × i's speed percentile in the pool. For Trick Room sets (a Trick Room user, or minus-Speed nature Brave, Quiet, Relaxed or Sassy), use 8 × (1 − percentile).
- **Utility, capped at 25:**

  | Feature | Points |
  |---|---|
  | Tailwind | 9 |
  | Trick Room | 9 if the pool has 3+ slow strong cards, else 4 |
  | Intimidate | 9 |
  | Fake Out | 8 |
  | Follow Me / Rage Powder | 8 |
  | Spore | 7 (other sleep moves 3) |
  | Weather or terrain setting ability | 5 |
  | STAB spread move with 80+ BP | 5 |
  | Icy Wind / Electroweb / Thunder Wave | 4 |
  | Wide Guard | 4 |
  | Prankster plus a status move | 4 |
  | Snarl, Will-O-Wisp, Encore, Parting Shot | 3 each |
  | Defiant / Competitive | 3 |
  | Helping Hand, Taunt | 2 each |
  | Focus Sash | 2 |

  Scarcity: if only 1 card in the pool provides a role, × 1.5 that role's points; if 4+ provide it, × 0.7.
- **Penalties:**
  - No Protect on a card that doesn't hold a Choice item or Assault Vest: −4.
  - Choice item: −2.
  - No STAB move of 80+ BP and no utility of 8+: −8.
  - Truant or Slow Start: −10.
  - A spread move that hits its own ally: −2.

### Draft: marginal value M(c | my team T)
`M = C(c) + RoleFill + SpeedModeSynergy + FieldSynergy + Coverage − WeaknessOverlap − ItemCost`
- **RoleFill:** the roles are SpeedControl, FakeOut, Intimidate, Redirection, SpreadAttacker and Attacker. Multiply c's utility points per role by 1.0 if T has none of that role, 0.4 if T has one, 0.1 if two or more.
  - When T has 3 cards and no SpeedControl, speed-control cards get +12.
  - When T has 4 cards and fewer than 2 attackers, attackers get +12.
- **Speed mode:** commit after my 2nd pick. Mode is TR if I have a Trick Room setter and a slow attacker, TW if I have a Tailwind setter, otherwise FAST.
  - +6 per Tailwind-setter + mid-speed-attacker pair, cap +12.
  - +6 per Trick Room-setter + slow-attacker pair, cap +12.
  - In TR mode, fast non-support cards −3.
- **FieldSynergy:**
  - +8 per weather or terrain setter + abuser pair (Chlorophyll, Swift Swim, Sand Rush, Slush Rush, Solar Power, Protosynthesis in sun, Quark Drive in Electric Terrain, Expanding Force in Psychic Terrain, Thunder or Hurricane in rain, Blizzard in snow).
  - −4 for two different weather setters.
- **WeaknessOverlap:** for each attacking type, if 3+ of T+c are weak to it and at most 1 resists, apply −6 × w(t). Here w(t) = min(2, 0.5 × the number of opponent or available cards with a STAB move of that type at 80+ BP). +3 if c resists a type that 2+ of T are weak to.
- **Coverage:** +3 for each opponent card that c OHKOs, or 2HKOs while outspeeding, when nothing in T already does.
- **ItemCost:** 0.5 × the best M among other remaining cards with the same item that rank in my top 3 (the Item Clause would lock me out of them).

### Draft: pick score and denial
`PickScore = M_me(c) + λ × Deny(c) + κ × Counter(c)`
- **Deny(c)** = the opponent's M for c using their team. It is 0 if c is not in `view.oppLegal`, and 0 if c isn't in their top-k, where k is how many picks they make before my next pick (usually 2).
- **λ:** 0.5 by default; 0.8 if c's value to them beats their next-best option by 15+; 0 if they have no picks left.
- **Counter(c):** the number of opponent cards c beats 1v1 that my team currently has no answer for. κ = 3, or 5 on my last pick.
- **Item Clause:** if my top card is illegal for the opponent and the best contested card is within 10 of it, take the contested card first.
- **Back-to-back picks:** choose the best pair jointly (M(a) + M(b | a)).
- **Pick 1:** the highest C.

### Team Preview
- **Bring:** enumerate all 15 bring-4 subsets S.
  - `BringScore(S) = Σ over the opponent's likely 4 of [weight(o) × max over s in S of Ans(s,o)] + RoleBonus − WeaknessOverlap`.
  - **Ans(s,o)** = oneVsOne(s,o) + 0.5 if s OHKOs o + 0.3 if s outspeeds o.
  - **RoleBonus:** +15 speed control, +8 Fake Out, +8 Intimidate, +5 redirection.
  - **Opponent's likely 4:** mirror this scoring from their side.
- **Hard rule:** if the opponent has Trick Room plus 2 or more slow attackers, S must include Taunt, Fake Out with a fast attacker, or 2 slow cards.
- **Leads:** of the 6 pairs in S, prefer a pair containing Fake Out, speed control or Intimidate. Keep the best answer to the opponent's strongest card in the back.

### Battle: per turn, priority order
0. **Filter self-harm:**
   - never a damaging move into my own ally;
   - no ally-hitting spread move unless the ally is immune or takes under 25% without fainting;
   - no Ground moves into Flying or Levitate;
   - no status moves into immunity;
   - no Fake Out unless it's the first turn on the field (`turnsOnField <= 1`);
   - no Trick Room while Trick Room is active;
   - no Tailwind while my Tailwind is active.
1. **Secure KO:** minimum roll ≥ the target's HP, and I move first or survive its hit.
2. **Fake Out** on the first turn into the biggest threat, unless the target is immune (Ghost type, Inner Focus, Covert Cloak, Armor Tail or Queenly Majesty ally, or Psychic Terrain).
3. **Speed control** (Tailwind, Trick Room, Icy Wind) if it flips 2 or more speed matchups and the setter survives.
4. **Protect** a slot if predicted incoming damage ≥ its HP or it's being double-targeted, and it did not Protect last turn. Never Protect twice in a row.
5. **Spread move** if its total damage beats the best single-target option.
6. **Focus fire** on the target with the highest threat (most damage it can deal to my side, × 1.3 if it outspeeds). Both slots hit the same target only if together they KO it and neither does alone. If one slot already KOs it, the other retargets.
7. **Otherwise,** the highest-damage move.

**Switching:** switch a slot out if it's predicted to be KO'd, can't Protect, and a bench card takes 40% or less from the predicted attacks. Never switch the same slot twice in a row.

**Forced switch:** bring in the bench card with the best 1v1 results against the current foes.

**Opponent prediction:** each foe uses its highest-damage move into the target it damages most, and Fake Out on its first turn if it has it.
