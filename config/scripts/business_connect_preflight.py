#!/usr/bin/env python3
"""Check a trusted server's business-connect evidence export without provider calls.

Usage: OMNI_BUSINESS_CONNECT_ENABLED=true business-connect-preflight --evidence export.json
Exit 0: evidence is consistent; 1: disabled/blocked; 2: invalid input.
This offline consistency check does not authenticate an export or authorize reads.
Never supply tokens, keys, ticket text, or raw provider responses. Export schema:
  schema: business-connect-evidence.v1
  session: kind=customer, issuerVerified, audienceVerified, membershipVerified,
    subjectId, orgId, expiresAt, revoked, revocationCheckedAt
  selections[]: provider, connectionId, accountId, revision (positive int), mode
  connections[]: id, provider, orgId, ownerSubjectId, revision, accountId, mode,
    state=ready, explicitSelectorSupported,
    permissions: verified, businessWrites, checkedAt
    readProbe: connectionId, accountId, revision, mode, orgId, succeeded, method, checkedAt
  inventoryComplete, inventoryObservedAt: required without an explicit broker selector
Modes are live/test; providers are stripe/meta_ads/zendesk/freshdesk. Shared-owner
connections are conservatively refused. Timestamps are Unix seconds. Identity,
membership, permissions and probes must come from the
verified customer service/broker, never from a browser form or internal admin.
"""

import argparse
import json
import math
import os
import sys
import time
from pathlib import Path

PROVIDERS = {"stripe", "meta_ads", "zendesk", "freshdesk"}
MAX_EVIDENCE_BYTES = 1_048_576
MAX_AGE_SECONDS = 300


def _text(value):
    return isinstance(value, str) and bool(value.strip()) and value == value.strip()


def _timestamp(value):
    return (
        type(value) in (int, float)
        and 0 < value <= 253_402_300_799
        and math.isfinite(value)
    )


def _fresh(value, now):
    return _timestamp(value) and now - MAX_AGE_SECONDS <= value <= now


def _result(status, issues):
    return {"status": status, "issues": sorted(set(issues)), "authorizesProviderReads": False}


def check_evidence(bundle, *, now, enabled=False):
    """Inspect evidence only; all identifiers stay out of the result."""
    if enabled is not True:
        return _result("disabled", ["feature_disabled"])
    if not isinstance(bundle, dict) or bundle.get("schema") != "business-connect-evidence.v1":
        return _result("blocked", ["invalid_schema"])
    session = bundle.get("session")
    selections = bundle.get("selections")
    connections = bundle.get("connections")
    if (
        not isinstance(session, dict)
        or not isinstance(selections, list)
        or not 1 <= len(selections) <= 3
        or not isinstance(connections, list)
        or not 1 <= len(connections) <= 32
        or any(not isinstance(row, dict) for row in selections + connections)
    ):
        return _result("blocked", ["invalid_evidence_shape"])

    issues = []
    if (
        session.get("kind") != "customer"
        or any(session.get(key) is not True for key in (
            "issuerVerified", "audienceVerified", "membershipVerified"
        ))
        or not _text(session.get("subjectId"))
        or not _text(session.get("orgId"))
        or not _timestamp(session.get("expiresAt"))
        or session["expiresAt"] <= now
        or session.get("revoked") is not False
        or not _fresh(session.get("revocationCheckedAt"), now)
    ):
        issues.append("customer_identity_unverified")

    seen = set()
    for index, selection in enumerate(selections):
        prefix = f"selection_{index}:"
        provider = selection.get("provider")
        if not isinstance(provider, str) or provider not in PROVIDERS:
            issues.append(prefix + "unsupported_provider")
            continue
        lane = "support" if provider in {"zendesk", "freshdesk"} else provider
        if lane in seen:
            issues.append(prefix + "duplicate_provider_lane")
        seen.add(lane)
        if (
            any(not _text(selection.get(key)) for key in ("connectionId", "accountId"))
            or type(selection.get("revision")) is not int
            or selection["revision"] < 1
            or selection.get("mode") not in ("live", "test")
        ):
            issues.append(prefix + "invalid_selection")
            continue
        matches = [row for row in connections if row.get("id") == selection["connectionId"]]
        if len(matches) != 1:
            issues.append(prefix + "connection_missing_or_ambiguous")
            continue
        connection = matches[0]
        if (
            connection.get("provider") != provider
            or connection.get("orgId") != session.get("orgId")
            or connection.get("ownerSubjectId") != session.get("subjectId")
            or connection.get("revision") != selection["revision"]
            or type(connection.get("revision")) is not int
            or connection.get("accountId") != selection["accountId"]
            or connection.get("mode") != selection["mode"]
        ):
            issues.append(prefix + "connection_binding_mismatch")
        if connection.get("state") != "ready":
            issues.append(prefix + "connection_not_ready")
        permissions = connection.get("permissions")
        if (
            not isinstance(permissions, dict)
            or permissions.get("verified") is not True
            or permissions.get("businessWrites") is not False
            or not _fresh(permissions.get("checkedAt"), now)
        ):
            issues.append(prefix + "readonly_permissions_unverified")
        if connection.get("explicitSelectorSupported") is not True:
            if (
                bundle.get("inventoryComplete") is not True
                or not _fresh(bundle.get("inventoryObservedAt"), now)
            ):
                issues.append(prefix + "broker_inventory_unverified")
            candidates = [row for row in connections if (
                row.get("provider") == provider
                and row.get("ownerSubjectId") == session.get("subjectId")
                and row.get("state") != "revoked"
            )]
            if len(candidates) != 1:
                issues.append(prefix + "implicit_broker_selection_ambiguous")
        probe = connection.get("readProbe")
        if (
            not isinstance(probe, dict)
            or probe.get("succeeded") is not True
            or probe.get("method") != "GET"
            or not _fresh(probe.get("checkedAt"), now)
            or probe.get("orgId") != session.get("orgId")
            or any(probe.get(key) != selection[key] for key in (
                "connectionId", "accountId", "revision", "mode"
            ))
            or type(probe.get("revision")) is not int
        ):
            issues.append(prefix + "account_readback_unverified")
    result = _result("blocked" if issues else "evidence_consistent", issues)
    result["testAccountSelected"] = any(row.get("mode") == "test" for row in selections)
    return result


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate_key")
        result[key] = value
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--evidence", required=True, type=Path)
    args = parser.parse_args(argv)
    if os.environ.get("OMNI_BUSINESS_CONNECT_ENABLED") != "true":
        print(json.dumps(_result("disabled", ["feature_disabled"])))
        return 1
    try:
        with args.evidence.open("rb") as source:
            raw = source.read(MAX_EVIDENCE_BYTES + 1)
        if len(raw) > MAX_EVIDENCE_BYTES:
            raise ValueError("oversized_evidence")
        bundle = json.loads(raw, object_pairs_hook=_unique_object)
        result = check_evidence(bundle, now=time.time(), enabled=True)
    except (OSError, ValueError, RecursionError):
        print(json.dumps(_result("invalid_input", ["unreadable_or_invalid_evidence"])))
        return 2
    print(json.dumps(result))
    return 0 if result["status"] == "evidence_consistent" else 1


if __name__ == "__main__":
    sys.exit(main())
