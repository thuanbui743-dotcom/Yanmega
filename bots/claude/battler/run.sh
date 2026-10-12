#!/bin/bash
# usage: run.sh <games> [extra bots]
export PATH="/c/Program Files/nodejs:$PATH"
cd /c/Users/Tuna/vgc
BATTLER_TIME=1 npx tsx scripts/league.ts --games ${1:-150} --bots ${2:-claude/battler,greedy} --workers 6 --seed ${SEED:-777} --logs ${3:-0} 2>&1 | grep -E "battler\]|claude/battler +│ '-'|matches in|results:" | awk '/battler\]/{n++; s+=$(NF-2)} !/battler\]/{print} END{if(n) printf "avg ms %.2f\n", s/n}'
