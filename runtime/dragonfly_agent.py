"""Dragonfly: AltruAgent agent for pokemon_vgc_doubles_draft.

The official starter (UCLA-Trustworthy-AI-Lab/altruagent-starter) runs the platform side. This module is
loaded with `--agent dragonfly_agent` (with this folder on PYTHONPATH). The starter creates one agent per
match, in that match's own process; each agent starts one Node decision bridge (adapter/bridge.ts), which
runs the frozen Dragonfly engine (bots/final/bot). Every decision is one JSON line each way.

If the bridge is slow, fails or returns something unusable, the agent answers with a simple legal move
instead, so a decision is never missed.
"""

from __future__ import annotations

import atexit
import json
import os
import queue
import shutil
import subprocess
import threading
import time
from pathlib import Path

from altruagent import DecisionContext, GameState, LegalAction

REPO = Path(__file__).resolve().parent.parent
# Per-phase answer budgets (seconds), inside the platform's limits: 15 s pick, 85 s preview, 50 s move.
BUDGET = {"draft": 11.0, "team_preview": 40.0, "moving": 30.0}
STARTUP_BUDGET = 25.0


def _node() -> str:
    return shutil.which("node") or r"C:\Program Files\nodejs\node.exe"


class Bridge:
    def __init__(self) -> None:
        logs = REPO / "logs"
        logs.mkdir(exist_ok=True)
        self.log = open(logs / f"bridge-{time.strftime('%Y%m%d-%H%M%S')}-{os.getpid()}.log", "a", encoding="utf-8")
        self.proc = subprocess.Popen(
            [_node(), "--import", "tsx", str(REPO / "adapter" / "bridge.ts")],
            cwd=str(REPO), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.log,
            text=True, encoding="utf-8", bufsize=1,
        )
        self.replies: "queue.Queue[dict]" = queue.Queue()
        self.ready = threading.Event()
        threading.Thread(target=self._read, daemon=True).start()
        atexit.register(self.close)
        self.next_id = 0

    def _read(self) -> None:
        for line in self.proc.stdout:  # type: ignore[union-attr]
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            if msg.get("ready"):
                self.ready.set()
            else:
                self.replies.put(msg)

    def ask(self, payload: dict, timeout: float) -> dict | None:
        if self.proc.poll() is not None:
            return None
        if not self.ready.wait(timeout=STARTUP_BUDGET):
            return None
        self.next_id += 1
        rid = self.next_id
        try:
            self.proc.stdin.write(json.dumps({"id": rid, **payload}) + "\n")  # type: ignore[union-attr]
            self.proc.stdin.flush()  # type: ignore[union-attr]
        except OSError:
            return None
        deadline = time.monotonic() + timeout
        while True:
            left = deadline - time.monotonic()
            if left <= 0:
                return None
            try:
                msg = self.replies.get(timeout=left)
            except queue.Empty:
                return None
            if msg.get("id") == rid:  # replies to timed-out requests are dropped
                return msg

    def close(self) -> None:
        if self.proc.poll() is None:
            self.proc.kill()


class DragonflyAgent:
    def __init__(self) -> None:
        self.bridge = Bridge()  # start Node now so the first draft pick is not slowed by startup

    def choose_action(self, state: GameState, context: DecisionContext):
        raw = state.raw if isinstance(state.raw, dict) else {}
        phase = raw.get("phase") or state.phase
        reply = self.bridge.ask(
            {"agent_id": context.agent_id, "phase": phase, "state": raw}, BUDGET.get(phase, 30.0)
        )
        action = (reply or {}).get("action")
        if isinstance(action, dict):
            if phase == "draft":
                match = _legal_for_card(state, action.get("card_id"))
                if match is not None:
                    return match
            elif _valid_shape(action, phase):
                return action
        self._note(f"FALLBACK phase={phase} reply={'none (timeout or bridge down)' if reply is None else reply}")
        return _fallback(state)

    def _note(self, msg: str) -> None:
        try:
            self.bridge.log.write(f"{time.strftime('%Y-%m-%dT%H:%M:%S')} [agent] {msg}\n")
            self.bridge.log.flush()
        except OSError:
            pass


def create_agent():
    return DragonflyAgent()


# ---------- fallbacks: simple legal moves (same approach as the starter's smoke agent) ----------

def _legal_for_card(state: GameState, card_id) -> LegalAction | None:
    for a in state.legal_actions:
        act = a.input.get("action") if isinstance(a.input, dict) else None
        if a.action_id == f"draft_pick:{card_id}" or (isinstance(act, dict) and act.get("card_id") == card_id):
            return a
    return None


def _valid_shape(action: dict, phase: str) -> bool:
    if phase == "team_preview":
        return action.get("type") == "select_lineup" and len(set(action.get("bring", []))) == 4 and len(action.get("leads", [])) == 2
    if phase == "moving":
        return action.get("type") == "doubles_turn" and isinstance(action.get("slot_0"), dict) and isinstance(action.get("slot_1"), dict)
    return False


def _fallback(state: GameState):
    first = state.legal_actions[0]
    template = first.input.get("action") if isinstance(first.input, dict) else None
    if first.action_id == "select_lineup" and isinstance(template, dict):
        roster = list(dict.fromkeys(template.get("roster", [])))
        return {"type": "select_lineup", "bring": roster[:4], "leads": roster[:2]}
    if first.action_id == "doubles_turn" and isinstance(template, dict):
        slots = sorted(template.get("slots", []), key=lambda s: s.get("slot", 0))
        out, taken = {}, None
        for slot in slots:
            choice = _slot_fallback(slot.get("options", []), taken)
            if choice.get("type") == "switch":
                taken = choice["species"]
            out[f"slot_{slot.get('slot', 0)}"] = choice
        if all(v.get("type") == "pass" for v in out.values()):
            for slot in slots:  # both passing is rejected: switch one slot if it can
                sw = next((o for o in slot.get("options", []) if o.get("type") == "switch"), None)
                if sw:
                    out[f"slot_{slot.get('slot', 0)}"] = {"type": "switch", "species": sw["species"]}
                    break
        return {"type": "doubles_turn", **out}
    return first


def _slot_fallback(options: list, taken) -> dict:
    kinds = {o.get("type") for o in options}
    if kinds <= {"pass"}:
        return {"type": "pass"}
    for o in options:
        if o.get("type") == "move" and o.get("move_id"):
            choice = {"type": "move", "move_id": o["move_id"]}
            targets = [t for t in (o.get("targets") or []) if isinstance(t, int)]
            if targets:
                choice["target"] = next((t for t in targets if t > 0), targets[0])
            return choice
    for o in options:
        if o.get("type") == "switch" and o.get("species") and o["species"] != taken:
            return {"type": "switch", "species": o["species"]}
    return {"type": "pass"}
