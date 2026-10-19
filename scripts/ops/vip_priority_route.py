#!/usr/bin/env python3
"""Apply W9-25 option C to an internal cs-triage board; no service calls.

vip-priority-route board.json --vip vip.json --mode shadow --report shadow.json
vip-priority-route board.json --vip vip.json --mode on --output board-vip.json

Consumes the audit's vip.py enrichment schema (cases keyed by case ID, with
tier/net_usd/sources/coverage). Amounts must already be net of refunds and
deduplicated across payment sources. This utility never looks up money.
Off is the default; off and shadow preserve the board exactly. On orders by
live risk, VIP membership, then existing urgency, and floors VIP+ at P1.
Only use the resulting board for internal triage, never customer messages.
"""

import argparse
import copy
import json
import math
import os
from pathlib import Path
import sys
import tempfile


def number(value):
    return type(value) in (int, float) and math.isfinite(value)


def live_risk(item):
    explicit = item.get("live_risk")
    if "live_risk" in item and type(explicit) is not bool:
        raise ValueError("live_risk must be a boolean")
    reasons = item.get("sensitive_reasons")
    if reasons is not None and (
        not isinstance(reasons, list) or not all(isinstance(r, str) for r in reasons)
    ):
        raise ValueError("sensitive_reasons must be a string list")
    if explicit is None and reasons is None:
        raise ValueError("each case needs live_risk or board.py sensitive_reasons")
    # Older board.py records its live risk list here; past disputes are not live risk.
    return explicit is True or any(r.startswith("risk: ") for r in reasons or [])


def route_board(board, enrichment=None, mode="off"):
    if mode not in ("off", "shadow", "on"):
        raise ValueError("mode must be off, shadow or on")
    if not isinstance(board, dict) or not isinstance(board.get("items"), list):
        raise ValueError("board must contain an items list")
    result = copy.deepcopy(board)
    report = {"mode": mode, "vip_cases": 0, "moves": []}
    if mode == "off":
        return result, report
    if not isinstance(enrichment, dict) or not isinstance(enrichment.get("cases"), dict):
        raise ValueError("shadow/on require vip.py enrichment with a cases object")
    vips = enrichment["cases"]
    for vip in vips.values():
        if not isinstance(vip, dict) or vip.get("tier") not in ("vip", "vip_plus"):
            raise ValueError("VIP entries need a vip or vip_plus tier")
        net = vip.get("net_usd")
        if not number(net) or net < 300:
            raise ValueError("VIP net_usd must be a finite number of at least $300")
        if (net >= 1000) != (vip["tier"] == "vip_plus"):
            raise ValueError("VIP tier must match the $300/$1,000 net-paid thresholds")
    positions, risks = {}, {}
    for index, item in enumerate(result["items"]):
        if not isinstance(item, dict) or not isinstance(item.get("id"), str) or not item["id"]:
            raise ValueError("each board case needs a nonempty string id")
        cid = item["id"]
        if cid in positions:
            raise ValueError("board case ids must be unique")
        if not number(item.get("urgency")) or item.get("tier") not in ("P0", "P1", "P2", "P3"):
            raise ValueError("each case needs finite urgency and an existing P0-P3 tier")
        positions[cid], risks[cid] = index, live_risk(item)
    # Reuses the staged board-vip.diff key; stable ties retain the board's order.
    proposed = sorted(result["items"], key=lambda i: (
        not risks[i["id"]], i["id"] not in vips, -i["urgency"]
    ))
    report["vip_cases"] = sum(i["id"] in vips for i in proposed)
    for index, item in enumerate(proposed):
        cid = item["id"]
        vip = vips.get(cid)
        floor = bool(vip and vip["tier"] == "vip_plus" and item["tier"] in ("P2", "P3"))
        if positions[cid] != index or floor:
            report["moves"].append({
                "id": cid, "from": positions[cid] + 1, "to": index + 1,
                "tier_from": item["tier"], "tier_to": "P1" if floor else item["tier"],
            })
        if mode == "on" and vip:
            item["vip"] = copy.deepcopy(vip)
            if floor:
                item["tier"] = "P1"
    if mode == "on":
        result["items"] = proposed
    return result, report


def read_json(path):
    with path.open(encoding="utf-8") as source:
        return json.load(source)


def atomic_write(path, content):
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                         prefix=".vip-route-", delete=False) as target:
            temporary = Path(target.name)
            target.write(content)
            target.flush()
            os.fsync(target.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("board", type=Path)
    parser.add_argument("--vip", type=Path, help="vip.py output from the same triage run")
    parser.add_argument("--mode", choices=("off", "shadow", "on"), default="off",
                        help="default: off; enrichment cannot enable routing")
    parser.add_argument("--output", type=Path, help="separate internal board file; default: stdout")
    parser.add_argument("--report", type=Path, help="separate shadow/movement report (case IDs only)")
    args = parser.parse_args(argv)
    try:
        inputs = [p.resolve() for p in (args.board, args.vip) if p]
        outputs = [p.resolve() for p in (args.output, args.report) if p]
        if len(set(outputs)) != len(outputs) or any(p in inputs for p in outputs):
            raise ValueError("output/report must be separate files and cannot replace inputs")
        if args.mode != "off" and args.vip is None:
            raise ValueError("--vip is required in shadow/on mode")
        board, report = route_board(read_json(args.board),
                                    read_json(args.vip) if args.vip and args.mode != "off" else None,
                                    args.mode)
        content = json.dumps(board, indent=2, allow_nan=False) + "\n"
        if args.report:
            atomic_write(args.report, json.dumps(report, indent=2, allow_nan=False) + "\n")
        if args.output:
            atomic_write(args.output, content)
        else:
            sys.stdout.write(content)
    except (OSError, ValueError, OverflowError):
        # JSON decoder errors can contain customer text; do not echo their messages.
        print("VIP routing failed: check input schema, mode and separate output paths; inputs unchanged.",
              file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
