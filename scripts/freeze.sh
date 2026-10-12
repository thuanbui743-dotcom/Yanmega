#!/usr/bin/env bash
# Snapshot the current Claude drafter and battler into bots/final (the tournament bot).
# Usage: bash scripts/freeze.sh
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf bots/final/drafter bots/final/battler
mkdir -p bots/final/drafter bots/final/battler
cp bots/claude/drafter/*.ts bots/final/drafter/
cp bots/claude/battler/engine.ts bots/claude/battler/index.ts bots/final/battler/
# Copied files import the arena with ../../../src; one level shallower here is the same depth, so nothing to rewrite.
echo "frozen: $(ls bots/final/drafter | tr '\n' ' ') | $(ls bots/final/battler | tr '\n' ' ')"
