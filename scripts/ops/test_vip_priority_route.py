import contextlib
import copy
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import vip_priority_route as routing


def case(cid, urgency, risk=False, tier="P2"):
    return {"id": cid, "urgency": urgency, "tier": tier,
            "sensitive_reasons": ["risk: legal"] if risk else [],
            "draft": {"reply": "Your account is fixed."}, "lane": "needs_sal"}


def vip(net=300):
    return {"tier": "vip_plus" if net >= 1000 else "vip", "net_usd": net,
            "sources": {"stripe": net}, "coverage": ["ledger unavailable"]}


class RoutingTests(unittest.TestCase):
    def setUp(self):
        self.board = {"items": [case("routine", 80, tier="P0"), case("vip", 20),
                                case("risk", 10, True), case("plus", 0, tier="P3")],
                      "counts": {"waiting_on_us": 4}, "issues": []}
        self.enrichment = {"mode": "on", "cases": {"vip": vip(), "plus": vip(1000)}}

    def test_default_off_ignores_enrichment_mode_and_bad_enrichment(self):
        for enrichment in (None, self.enrichment, {"cases": "invalid"}):
            result, report = routing.route_board(self.board, enrichment)
            self.assertEqual(result, self.board)
            self.assertEqual(report["moves"], [])
            self.assertIsNot(result, self.board)

    def test_shadow_preserves_every_board_field_and_reports_proposed_moves(self):
        original = copy.deepcopy(self.board)
        result, report = routing.route_board(self.board, self.enrichment, "shadow")
        self.assertEqual(result, original)
        self.assertEqual(self.board, original)
        self.assertEqual(report["vip_cases"], 2)
        moves = {m["id"]: m for m in report["moves"]}
        self.assertEqual(moves["risk"]["to"], 1)
        self.assertEqual(moves["plus"]["tier_to"], "P1")
        self.assertNotIn("reply", json.dumps(report))

    def test_on_risk_then_vip_then_urgency_without_changing_points_or_authority(self):
        original = copy.deepcopy(self.board)
        result, report = routing.route_board(self.board, self.enrichment, "on")
        self.assertEqual([i["id"] for i in result["items"]], ["risk", "vip", "plus", "routine"])
        for item in result["items"]:
            before = next(i for i in original["items"] if i["id"] == item["id"])
            for field in ("urgency", "draft", "lane", "sensitive_reasons"):
                self.assertEqual(item[field], before[field])
        self.assertEqual(result["items"][2]["tier"], "P1")
        self.assertEqual(result["items"][2]["vip"]["coverage"], ["ledger unavailable"])
        self.assertEqual(result["counts"], original["counts"])
        self.assertEqual(self.board, original)
        again, _ = routing.route_board(result, self.enrichment, "on")
        self.assertEqual(again, result)

    def test_risk_band_vips_then_urgency_and_stable_ties(self):
        board = {"items": [case("a", 90, True), case("b", 10, True),
                            case("c", 10, True), case("d", 999)]}
        result, _ = routing.route_board(board, {"cases": {"b": vip(), "c": vip()}}, "on")
        self.assertEqual([i["id"] for i in result["items"]], ["b", "c", "a", "d"])

    def test_empty_queue_and_exact_threshold_boundaries(self):
        result, report = routing.route_board({"items": []}, {"cases": {}}, "on")
        self.assertEqual(result, {"items": []})
        self.assertEqual(report["vip_cases"], 0)
        self.board["items"][3]["tier"] = "P2"
        for net, expected_tier in ((300, "P2"), (999.99, "P2"), (1000, "P1")):
            result, _ = routing.route_board(self.board, {"cases": {"plus": vip(net)}}, "on")
            item = next(i for i in result["items"] if i["id"] == "plus")
            self.assertEqual(item["tier"], expected_tier)

    def test_explicit_risk_and_legacy_risk_both_protect_customers(self):
        self.board["items"][0]["live_risk"] = True
        self.board["items"][2]["live_risk"] = False
        result, _ = routing.route_board(self.board, self.enrichment, "on")
        self.assertEqual([i["id"] for i in result["items"]][:2], ["routine", "risk"])

    def test_historical_dispute_is_not_live_risk_and_p0_p1_are_not_lowered(self):
        self.enrichment["cases"]["vip"]["any_dispute"] = True
        for tier in ("P0", "P1"):
            self.board["items"][3]["tier"] = tier
            result, _ = routing.route_board(self.board, self.enrichment, "on")
            self.assertEqual(result["items"][0]["id"], "risk")
            self.assertEqual(result["items"][2]["tier"], tier)

    def test_invalid_money_or_tier_never_qualifies(self):
        for bad in ({"tier": "vip", "net_usd": net} for net in
                    (299.99, -300, True, "300", None, float("nan"), float("inf"))):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                routing.route_board(self.board, {"cases": {"vip": bad}}, "on")
        for bad in (vip(999), vip(1000), {"tier": "staff", "net_usd": 500}, None):
            if isinstance(bad, dict) and bad["tier"] in ("vip", "vip_plus"):
                bad["tier"] = "vip" if bad["tier"] == "vip_plus" else "vip_plus"
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                routing.route_board(self.board, {"cases": {"vip": bad}}, "shadow")

    def test_invalid_board_risk_or_urgency_fails_closed(self):
        bad_items = [{"id": "x", "tier": "P2", "urgency": 0},
                     dict(case("x", 0), live_risk="false"),
                     dict(case("x", 0), sensitive_reasons="risk: legal"),
                     case("x", float("nan")), case("x", True), case("x", 10, tier="VIP")]
        for item in bad_items:
            with self.subTest(item=item), self.assertRaises(ValueError):
                routing.route_board({"items": [item]}, {"cases": {}}, "on")
        with self.assertRaises(ValueError):
            routing.route_board({"items": [case("x", 0)] * 2}, {"cases": {}}, "on")


class CliTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.board = self.root / "board.json"
        self.enrichment = self.root / "vip.json"
        self.output = self.root / "output.json"
        self.report = self.root / "report.json"
        self.board.write_text(json.dumps({"items": [case("normal", 50), case("vip", 0)]}))
        self.enrichment.write_text(json.dumps({"mode": "on", "cases": {"vip": vip(1000)}}))

    def run_cli(self, *args):
        return subprocess.run([sys.executable, str(Path(routing.__file__)), str(self.board), *map(str, args)],
                              capture_output=True, text=True)

    def test_cli_off_shadow_and_on_leave_inputs_unchanged(self):
        original = self.board.read_bytes(), self.enrichment.read_bytes()
        for mode in (None, "shadow", "on"):
            args = ["--vip", self.enrichment, "--report", self.report]
            if mode:
                args += ["--mode", mode, "--output", self.output]
            completed = self.run_cli(*args)
            self.assertEqual(completed.returncode, 0, completed.stderr)
            result = json.loads(self.output.read_text() if mode else completed.stdout)
            self.assertEqual(result["items"][0]["id"], "vip" if mode == "on" else "normal")
            self.assertEqual((self.board.read_bytes(), self.enrichment.read_bytes()), original)

    def test_input_and_output_aliases_are_rejected(self):
        for args in (["--output", self.board], ["--report", self.enrichment, "--vip", self.enrichment],
                     ["--output", self.output, "--report", self.output]):
            completed = self.run_cli(*args)
            self.assertEqual(completed.returncode, 2)
        alias = self.root / "alias.json"
        try:
            alias.symlink_to(self.board)
        except OSError:
            return  # Windows without symlink privileges still covers direct aliases.
        self.assertEqual(self.run_cli("--output", alias).returncode, 2)

    def test_missing_or_corrupt_inputs_preserve_previous_output_and_hide_customer_text(self):
        self.output.write_text("previous output")
        self.enrichment.write_text('{"private@example.org": invalid}')
        for args in (["--mode", "on"], ["--mode", "on", "--vip", self.enrichment]):
            completed = self.run_cli(*args, "--output", self.output)
            self.assertEqual(completed.returncode, 2)
            self.assertEqual(self.output.read_text(), "previous output")
            self.assertNotIn("private@example.org", completed.stderr)
            self.assertEqual(completed.stdout, "")

    def test_failed_atomic_replace_keeps_previous_output_and_cleans_temporary_file(self):
        self.output.write_text("previous output")
        with patch.object(routing.os, "replace", side_effect=OSError("disk error")):
            with contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(routing.main([str(self.board), "--output", str(self.output)]), 2)
        self.assertEqual(self.output.read_text(), "previous output")
        self.assertEqual(list(self.root.glob(".vip-route-*")), [])


if __name__ == "__main__":
    unittest.main()
