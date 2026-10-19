import copy
import importlib.util
import io
import json
import os
from contextlib import redirect_stdout
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).with_name("business_connect_preflight.py")
SPEC = importlib.util.spec_from_file_location("business_connect_preflight", SCRIPT)
preflight = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(preflight)
NOW = 1_800_000_000


def evidence():
    selection = {
        "provider": "stripe", "connectionId": "connection-1", "accountId": "account-1",
        "revision": 1, "mode": "live"
    }
    return {
        "schema": "business-connect-evidence.v1",
        "inventoryComplete": True, "inventoryObservedAt": NOW,
        "session": {
            "kind": "customer", "issuerVerified": True, "audienceVerified": True,
            "membershipVerified": True, "subjectId": "person-1", "orgId": "org-1",
            "expiresAt": NOW + 60, "revoked": False, "revocationCheckedAt": NOW
        },
        "selections": [selection],
        "connections": [{
            "id": "connection-1", "provider": "stripe", "orgId": "org-1",
            "ownerSubjectId": "person-1", "revision": 1, "accountId": "account-1",
            "mode": "live", "state": "ready", "explicitSelectorSupported": True,
            "permissions": {"verified": True, "businessWrites": False, "checkedAt": NOW},
            "readProbe": {**selection, "orgId": "org-1", "succeeded": True,
                          "method": "GET", "checkedAt": NOW}
        }]
    }


class ConnectionPreflightTests(unittest.TestCase):
    def check(self, bundle):
        return preflight.check_evidence(bundle, now=NOW, enabled=True)

    def assert_blocked(self, bundle, issue):
        result = self.check(bundle)
        self.assertEqual(result["status"], "blocked")
        self.assertTrue(any(issue in item for item in result["issues"]), result)
        self.assertFalse(result["authorizesProviderReads"])

    def test_default_off(self):
        self.assertEqual(preflight.check_evidence(evidence(), now=NOW)["status"], "disabled")

    def test_each_supported_provider_can_have_consistent_evidence(self):
        for provider in preflight.PROVIDERS:
            with self.subTest(provider=provider):
                bundle = evidence()
                bundle["selections"][0]["provider"] = provider
                bundle["connections"][0]["provider"] = provider
                self.assertEqual(self.check(bundle)["status"], "evidence_consistent")
                self.assertFalse(self.check(bundle)["authorizesProviderReads"])

    def test_missing_expired_revoked_or_internal_identity(self):
        changes = {
            "kind": "internal_admin", "issuerVerified": False, "audienceVerified": False,
            "membershipVerified": False, "subjectId": "", "orgId": "",
            "expiresAt": NOW, "revoked": True, "revocationCheckedAt": NOW - 301
        }
        for key, value in changes.items():
            with self.subTest(key=key):
                bundle = evidence()
                bundle["session"][key] = value
                self.assert_blocked(bundle, "customer_identity_unverified")

    def test_same_owner_cannot_cross_organization_or_account(self):
        for key, value in {"orgId": "org-2", "ownerSubjectId": "person-2",
                           "accountId": "account-2", "revision": 2, "mode": "test",
                           "provider": "meta_ads"}.items():
            with self.subTest(key=key):
                bundle = evidence()
                bundle["connections"][0][key] = value
                self.assert_blocked(bundle, "connection_binding_mismatch")

    def test_probe_does_not_establish_readonly_permissions(self):
        for permissions in (None, {}, {"verified": True, "businessWrites": True},
                            {"verified": True, "businessWrites": False, "checkedAt": NOW - 301}):
            bundle = evidence()
            bundle["connections"][0]["permissions"] = permissions
            self.assert_blocked(bundle, "readonly_permissions_unverified")

    def test_revoked_connection_and_stale_or_wrong_account_probe(self):
        bundle = evidence()
        bundle["connections"][0]["state"] = "revoked"
        self.assert_blocked(bundle, "connection_not_ready")
        for key, value in {"accountId": "other", "orgId": "org-2", "revision": 2,
                           "checkedAt": NOW - 301, "method": "POST", "mode": "test",
                           "connectionId": "other", "succeeded": False}.items():
            with self.subTest(key=key):
                bundle = evidence()
                bundle["connections"][0]["readProbe"][key] = value
                self.assert_blocked(bundle, "account_readback_unverified")

    def test_broker_without_selector_refuses_second_connection_even_in_other_org(self):
        bundle = evidence()
        connection = bundle["connections"][0]
        connection["explicitSelectorSupported"] = False
        self.assertEqual(self.check(bundle)["status"], "evidence_consistent")
        other = copy.deepcopy(connection)
        other.update(id="connection-2", orgId="org-2", accountId="account-2")
        bundle["connections"].append(other)
        self.assert_blocked(bundle, "implicit_broker_selection_ambiguous")
        connection["explicitSelectorSupported"] = True
        self.assertEqual(self.check(bundle)["status"], "evidence_consistent")

    def test_implicit_selection_needs_complete_fresh_inventory(self):
        for key, value in {"inventoryComplete": False, "inventoryObservedAt": NOW - 301}.items():
            bundle = evidence()
            bundle["connections"][0]["explicitSelectorSupported"] = False
            bundle[key] = value
            self.assert_blocked(bundle, "broker_inventory_unverified")

    def test_test_account_is_labeled(self):
        bundle = evidence()
        bundle["selections"][0]["mode"] = "test"
        bundle["connections"][0]["mode"] = "test"
        bundle["connections"][0]["readProbe"]["mode"] = "test"
        result = self.check(bundle)
        self.assertEqual(result["status"], "evidence_consistent")
        self.assertTrue(result["testAccountSelected"])

    def test_missing_duplicate_unknown_and_two_support_desks(self):
        bundle = evidence()
        bundle["connections"] *= 2
        self.assert_blocked(bundle, "connection_missing_or_ambiguous")
        bundle = evidence()
        bundle["selections"][0]["provider"] = "slack"
        self.assert_blocked(bundle, "unsupported_provider")
        bundle["selections"] = [{**bundle["selections"][0], "provider": provider}
                                for provider in ("zendesk", "freshdesk")]
        self.assert_blocked(bundle, "duplicate_provider_lane")

    def test_malformed_values_fail_closed(self):
        for bundle in (None, [], {}, {**evidence(), "connections": [None]},
                       {**evidence(), "selections": []}):
            with self.subTest(bundle=bundle):
                self.assertEqual(self.check(bundle)["status"], "blocked")
        bundle = evidence()
        bundle["selections"][0]["provider"] = ["stripe"]
        self.assert_blocked(bundle, "unsupported_provider")
        bundle = evidence()
        bundle["selections"][0]["revision"] = True
        self.assert_blocked(bundle, "invalid_selection")
        for value in (True, float("nan"), float("inf"), "1800000000", NOW + 1, 10 ** 400):
            bundle = evidence()
            bundle["session"]["revocationCheckedAt"] = value
            self.assert_blocked(bundle, "customer_identity_unverified")

    def run_cli(self, path, enabled="true"):
        output = io.StringIO()
        with patch.dict(os.environ, {"OMNI_BUSINESS_CONNECT_ENABLED": enabled}), \
                patch.object(preflight.time, "time", return_value=NOW), redirect_stdout(output):
            code = preflight.main(["--evidence", str(path)])
        return code, json.loads(output.getvalue())

    def test_cli_exit_codes_and_redaction(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "evidence.json"
            self.assertEqual(self.run_cli(path, "false")[0], 1)
            self.assertEqual(self.run_cli(path)[0], 2)
            bundle = evidence()
            path.write_text(json.dumps(bundle))
            self.assertEqual(self.run_cli(path)[0], 0)
            bundle["connections"][0]["accountId"] = "secret-account-marker"
            path.write_text(json.dumps(bundle))
            code, output = self.run_cli(path)
            self.assertEqual(code, 1)
            self.assertNotIn("secret-account-marker", json.dumps(output))
            for invalid in ('{"schema":1,"schema":2}', 'secret-token',
                            '[' * 2000, ' ' * (preflight.MAX_EVIDENCE_BYTES + 1)):
                path.write_text(invalid)
                self.assertEqual(self.run_cli(path)[0], 2)


if __name__ == "__main__":
    unittest.main()
