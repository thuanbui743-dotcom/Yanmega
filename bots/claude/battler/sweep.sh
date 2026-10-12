#!/bin/bash
# usage: sweep.sh games 'json1' 'json2' ...
export PATH="/c/Program Files/nodejs:$PATH"
g=$1; shift
for p in "$@"; do
  out=$(BATTLER_P="$p" /c/Users/Tuna/vgc/bots/claude/battler/run.sh $g)
  dir=$(echo "$out" | grep -oE "results: .*" | sed 's/results: //')
  ms=$(echo "$out" | grep -oE "avg ms [0-9.]+")
  wr=$(node -e "const s=require(process.argv[1]+'/summary.json');console.log(s.rows.find(r=>r.bot==='claude/battler').winPct)" "$dir")
  echo "$p => $wr% $ms"
done
