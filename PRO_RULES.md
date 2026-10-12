# Rules from top VGC players (research summary)

Sources: mostly VGC Guide (vgcguide.com; authors include Wolfe Glick and Aaron Zheng), Smogon, Nugget Bridge, and Pokemon Trash (which summarizes Wolfey's VGC Academy). Rules marked "extrapolated" are not directly sourced.

## Top 10 for a search bot
1. **[battle] Risk mode by game state.** If ahead, choose the joint action with the best worst case against the opponent's likely replies. If behind and that line still loses, choose the line that wins against the opponent's most likely reply ("play to your outs"). In between, take an expected-value read only when the payoff is large.
2. **[battle] Repeat Protect** succeeds about 1/3 of the time. A mon that Protected last turn is a high-value target, so raise the odds that the opponent attacks it.
3. **[battle] Free-switch check before a KO.** If KOing a target lets the opponent bring in a mon that beats your board for free, value leaving a harmless target alive (for example, a spent Tailwind setter).
4. **[battle] Stall opposing speed control.** While the opponent's Tailwind (4 turns including the set turn) or Trick Room (5 turns) favours them, add value per wasted turn: Protect, a switch into a resist, Fake Out, status.
5. **[preview] Rule of two.** Every opposing mon should have at least 2 answers among your 4. Penalize a bring with fewer, weighted by that mon's threat.
6. **[preview] Predict leads as synergy pairs:** Fake Out + attacker, Tailwind + attacker, redirection + setup or Trick Room. Lead to beat their top pairs. If they have no counter to your best combo, lead it.
7. **[battle + preview] Preserve the win condition.** Tag the mon that beats the opponent's remaining team. Raise the penalty for losing it, and don't trade a mon that answers an opposing threat that hasn't come out yet.
8. **[battle] Prefer accurate moves when ahead.** Use a 100%-accuracy option if it meets the same KO threshold. Allow low-accuracy or chance plays mainly when behind.
9. **[battle] Protect only for a gain:** the mon dies or is crippled otherwise, it burns opposing Tailwind or Trick Room turns, or it blocks Fake Out or a double-target. Check that the partner survives being double-targeted. Penalize Protect if the opponent can use the free turn to set up, switch or set speed control.
10. **[draft] Hate-draft enablers.** Raise a card's value by how much it completes the opponent's mode (for example, a Trick Room setter for their slow attackers). Value support roughly as redirection > Fake Out > Prankster or weather; Prankster Tailwind is highly valuable. (Extrapolated.)

## Other rules
- **[preview] Bring by elimination.** Drop mons whose attacks most of their team resists, mons that take neutral or super-effective hits from most of their team while doing little damage, and mons whose role is wasted (Tailwind into Trick Room). Drop half of a combo if the other half sits out. Require an answer to every solo threat.
- **[preview] Every lead needs a job:** speed control, damage or disruption. Penalize two-support leads, and leading your win condition into its counter. The back two should fix the lead's worst matchup.
- **[battle] Value potential speed:** evaluate turn order after pending speed control resolves.
- **[battle] Low-HP mons:** keep one if it can come back safely and still act. Otherwise sacrificing it is fine, to stall speed control turns, give a free switch or re-trigger Intimidate.
- **[battle] Switch only with a purpose:** the switch-in must take acceptable damage and threaten something. Penalize switch chains that deal no damage.
- **[battle] Attack into mons with no Protect, or that just Protected.**
- **[battle] Fake Out the mon whose action swings the turn most:** the speed control setter, or the KO threat on your partner.
- **[battle] Double Protect** only if every other joint action loses badly.
- **[draft] Horizontal synergy.** Each pick should pair with an earlier pick as a lead pair. Attackers early, support later. Watch for big speed-tier gaps.
- **[draft] Keep a mode answer.** Penalize a six with no speed control or Fake Out. Keep at least one Trick Room answer (a fast KO on the setter, Fake Out or Taunt).

## Mistakes strong players punish
- Overpredicting.
- Protecting by habit.
- KOing just because a KO is available.
- Losing track of Tailwind or Trick Room turn counts.
- Giving up winnable games.
- Leading physical attackers into Intimidate.
