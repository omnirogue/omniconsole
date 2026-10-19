# Enterprise S2S and self-hosting

This guide covers operating `omnisi-evolve`, authenticating service-to-service
(S2S) integrations, and enforcing shared organization budgets. It is for platform
administrators deploying their own service and workers.

**Version scope: 2026-10-16.** The deployment and backend contracts below were
checked against `omnirogue/omnidots-cloud` commit
[`d9608464b788`](https://github.com/omnirogue/omnidots-cloud/commit/d9608464b788f0aa858c24aa7edeedc65b09a9d8).
That source snapshot includes an Apache-2.0 self-hosting package; its standalone
public repository publication is still listed as pending. Obtain authorized
source access and pin a reviewed revision. Do not assume a published container,
Helm chart, or standalone repository exists. Links to that source may require
repository access.

## Contents

- [Deployment boundaries](#deployment-boundaries)
- [Deploy the Evolve service](#deploy-the-evolve-service)
- [Configure identity and service accounts](#configure-identity-and-service-accounts)
- [Configure OmniRogue S2S keys](#configure-omnirogue-s2s-keys)
- [Set organization-wide budget policies](#set-organization-wide-budget-policies)
- [Operate, recover, and upgrade](#operate-recover-and-upgrade)
- [Troubleshooting](#troubleshooting)
- [Acceptance checklist and references](#acceptance-checklist-and-references)

## Deployment boundaries

```text
CLI / enterprise application
  | RS256 JWT over HTTPS
  v
TLS ingress -> omnisi-evolve-service -> PostgreSQL with organization RLS
                        ^
                        | leases, reservations, results
                 organization workers -> configured model providers

Optional OmniSI application -> OmniRogue wallet / media APIs
                               S2S key + verified on-behalf-of user
```

| Component | Responsibility |
| --- | --- |
| `omnisi-evolve` engine library | Candidate generation interfaces, evaluation, selection, and run evidence. |
| `omnisi-evolve-service` | REST/SSE, tenant isolation, run admission, leases, cost reservations, and promotion records. |
| `omnisi-evolve-cli` | Installs the `omnisi-evolve` command for submitting and inspecting runs. |
| Your worker integration | Claims queued work, drives the engine and providers, persists results, and settles costs. |
| Optional OmniSI application bridge | Uses OmniRogue S2S credentials for wallet and media operations. Separate from standalone Evolve authentication. |

The supplied Compose deployment starts PostgreSQL, migrations, and the HTTP
service. **It does not start a model-execution worker.** A successful submission
proves admission, not completed computation. Provider credentials and executable
evaluators belong on isolated workers, with explicit network and filesystem
access. Treat generated code and evaluation inputs as untrusted.

Self-hosting keeps service state in your infrastructure; provider calls may
still transmit prompts and data outside it. Define permitted providers, data
classes, retention, and regions before enabling those calls.

### Choose the authentication boundary

| Connection | Credential | Configuration owner |
| --- | --- | --- |
| Client or worker to standalone Evolve | Short-lived RS256 JWT with organization claims | Your identity provider and Evolve service |
| OmniSI application to OmniRogue | Registered S2S key ID and secret | OmniSI backend and OmniRogue operator |
| Desktop to hosted Evolve | Existing OmniRogue account lease | Desktop account connection and compatible gateway |
| Worker to model provider | Provider credential or supported subscription login | Worker runtime |

These credentials are not interchangeable. An OmniRogue S2S key does not
authenticate directly to `omnisi-evolve-service`.

## Deploy the Evolve service

### Prerequisites

- An approved, pinned `omnidots-cloud` source checkout, including `rust/` and
  `oss/omnisi-evolve/`; the Docker build uses the repository root as its context.
- Docker Engine and Docker Compose with dependency health/completion conditions.
  The supplied database image is PostgreSQL 16.
- An identity provider issuing RS256 tokens and an exported public JWKS file.
- A private service network, HTTPS ingress, persistent database storage, backups,
  and a secret manager that injects environment variables into the right process.
- For native builds, Rust 1.89 or newer for the service and CLI. The engine
  library's documented minimum is 1.87.
- A worker implementation compatible with the pinned engine and service schema.

The examples use synthetic organization names and example domains. Substitute
your own values. Commands in this guide are deployment instructions, not evidence
that a deployment has already been performed.

### Environment inventory

| Variable | Where used | Required behavior / default |
| --- | --- | --- |
| `POSTGRES_PASSWORD` | Compose database and migration job | Inject the database owner's secret. Never give it to application workers. |
| `APP_DB_PASSWORD` | Compose migration and service | Inject the separate `omnidots_app` password. |
| `EVOLVE_ORG_ID` | Compose migration job | Organization to provision; must equal the JWT's `org_id`. |
| `EVOLVE_MAX_DAILY_CANDIDATES` | Migration job | Organization candidate limit; default `500`. |
| `EVOLVE_MAX_DAILY_COST_CENTS` | Migration job | Organization cost limit in integer cents; default `10000`. |
| `DATABASE_URL` | Service | PostgreSQL connection using an RLS-bound application role. Compose supplies it. |
| `PGPASSWORD` | Service / migration process | Corresponding role password; Compose injects the appropriate secret separately. |
| `EVOLVE_JWKS_FILE` | Service | Public JWKS file path; Compose mounts `/run/evolve/jwks.json`. |
| `AUTH_ISSUER`, `AUTH_AUDIENCE` | Service | Exact expected token issuer and audience. Required with JWKS. |
| `EVOLVE_BIND` | Service | Native default `127.0.0.1:8095`; Compose binds inside the container to `0.0.0.0:8095`. |
| `EVOLVE_SWEEP_SECONDS` | Service | Lease/reservation reclamation interval; default `30`. Add to your deployment environment if overriding. |
| `EVOLVE_STORE` | Service | `memory` is disposable, process-local storage. Leave unset for PostgreSQL. |
| `OMNISI_EVOLVE_URL` | CLI | Service origin; default `http://127.0.0.1:8095`. |
| `OMNISI_EVOLVE_TOKEN` | CLI | JWT, injected into the client process. There is no token command-line flag. |

### Start with Docker Compose

From the pinned source checkout, after your secret manager has populated the two
password variables:

```bash
set +x
: "${POSTGRES_PASSWORD:?inject the database owner password}"
: "${APP_DB_PASSWORD:?inject the application password}"
export EVOLVE_ORG_ID='org-example'
export AUTH_ISSUER='https://auth.example.com'
export AUTH_AUDIENCE='omnisi-evolve'
export EVOLVE_MAX_DAILY_CANDIDATES='500'
export EVOLVE_MAX_DAILY_COST_CENTS='10000'

# This file contains public verification keys, never private signing keys.
cp /path/to/public-jwks.json oss/omnisi-evolve/jwks.json
docker compose -f oss/omnisi-evolve/compose.yaml up --build -d
docker compose -f oss/omnisi-evolve/compose.yaml ps -a
docker compose -f oss/omnisi-evolve/compose.yaml logs --tail=100 migrate evolve
curl --fail --silent --show-error http://127.0.0.1:8095/healthz
```

The migration job must exit successfully before Evolve starts. It applies the
bundled schema files in filename order, sets the application role's password,
and provisions the named organization and budget. The named `evolve-pg` volume
holds PostgreSQL data. Do not use `docker compose down -v` on retained data.

The migration script is designed for reruns, but also verifies an existing
`evolve_fence()` definition against an approved fingerprint. A mismatch needs
schema investigation; do not remove the check or rewrite the function blindly.
Rerunning provisioning also reapplies the configured budget limits, so keep them
aligned with subsequent operator changes.

Compose publishes port 8095 on host loopback only and does not publish
PostgreSQL. Terminate TLS at your ingress and forward the two API prefixes
(`/api/evolve` and `/evolve`) consistently. Preserve `Authorization` and
`Last-Event-ID`, disable response buffering for SSE, and allow long-lived event
streams. Do not log authorization headers, tokens, S2S keys, or sensitive bodies.

`/healthz` returns `ok` without querying the database or authenticating a user.
Use an authenticated read as a separate readiness check. PostgreSQL failure or
an unsafe database role can remain hidden behind a successful health response.

### Native installation

When building outside Docker, install from the same pinned checkout:

```bash
cargo install --locked --path rust/crates/omnisi-evolve-service
cargo install --locked --features uuid/serde --path rust/crates/omnisi-evolve-cli
```

The CLI feature flag is required by the documented source snapshot. Provision
the bundled schema using `oss/omnisi-evolve/migrate.sh`, PostgreSQL connection
variables, `APP_DB_PASSWORD`, and `SCHEMA_DIR` pointing to the bundled schema
directory. Its `psql` client must support `\getenv` (PostgreSQL 15 or newer).
Run migrations as the owner, then run `omnisi-evolve-service` under a dedicated
unprivileged OS account with the application database credentials and JWKS
configuration. Keep migration credentials out of the service environment.

## Configure identity and service accounts

### JWT configuration

Configure your issuer to mint tokens with an RS256 signature and a `kid` header
matching a public key in `EVOLVE_JWKS_FILE`. Required claims are:

| Claim | Example | Meaning |
| --- | --- | --- |
| `sub` | `svc-evolve-ci` | Auditable person or service identity. |
| `org_id` | `org-example` | Database tenant; assigned by the trusted issuer. |
| `iss` | `https://auth.example.com` | Must match `AUTH_ISSUER`. |
| `aud` | `omnisi-evolve` | Must match `AUTH_AUDIENCE`. |
| `exp` | Issuer-generated Unix timestamp | Expiry; the verifier permits no expiry leeway. |

Use short-lived service tokens and synchronized clocks. `sub` and `org_id` must
be nonempty, trimmed strings without control characters, at most 256 bytes.
The service selects only configured keys; a token-supplied key URL is not trusted.

Organization identity comes from verified claims, not a request body. Optional
`X-Org-Id`, `X-Person-Id`, `X-Omnidots-Org-Id`, and
`X-Omnidots-Person-Id` headers are consistency assertions in JWT mode; a mismatch
returns `403 tenant_header_mismatch`.

The standalone verifier does not implement per-route scopes or organization
admin roles. If submitters, workers, and promotion approvers need different
permissions, enforce that policy in your authenticated gateway and network
layout, and block direct service access. A descriptive `sub` alone does not
restrict the token to worker operations.

Without a JWKS file, the service uses trusted proxy identity headers and refuses
a non-loopback listener. This is an explicit local trust mode, not anonymous
authentication. Any local process able to reach it can assert those headers.
Prefer JWT mode; a trusted proxy must strip caller-supplied identity headers
before injecting its own verified identity.

### Verify access and submit a small run

Inject a short-lived token into `OMNISI_EVOLVE_TOKEN`. Use the origin without an
API suffix; the CLI appends its API paths. This authenticated read passes the
header through standard input rather than exposing it in curl's argument list:

```bash
set +x
export OMNISI_EVOLVE_URL='https://evolve.example.com'
: "${OMNISI_EVOLVE_TOKEN:?inject a short-lived JWT}"
curl --fail --silent --show-error --config - <<EOF
url = "${OMNISI_EVOLVE_URL}/api/evolve/runs"
header = "Authorization: Bearer ${OMNISI_EVOLVE_TOKEN}"
EOF
```

For an approved staging run, generate and edit a real evaluation spec before
submitting. The starter contains a placeholder evaluator:

```bash
omnisi-evolve init --target prompt
# Edit evolve-spec.json: objective, baseline, evaluator, data, and budget.
omnisi-evolve run --spec evolve-spec.json --generations 1 \
  --candidates-per-generation 2 --estimated-cost-cents 100
omnisi-evolve status --run-id '<returned-run-uuid>'
```

Keep the returned UUID. This request admits two candidates and reserves 100
cents; it does not prove that a worker has run. A request timeout can occur after
admission. The standalone create route has no documented idempotency contract:
reconcile the organization's run list before resubmitting.

### Rotate JWT signing keys

1. Add the new public key alongside the old one in JWKS, using a distinct `kid`.
2. Replace the mounted file and restart/recreate every service replica. The
   standalone binary reads JWKS at startup; no hot reload is implemented.
3. Verify tokens signed by the new key, then switch the issuer to it.
4. After old tokens expire and streams reconnect, remove the old key and restart
   replicas again. For compromise, revoke immediately and terminate affected
   sessions according to your incident procedure.

SSE authentication occurs when the stream opens, and the stream closes at token
expiry. Obtain a fresh token and reconnect using `Last-Event-ID`; refreshing a
token elsewhere does not update an existing stream.

### Desktop compatibility

The desktop hosted client uses `OMNISI_CLOUD_URL` (default
`https://app.omnisi.ai`) and an OmniRogue account lease. Changing that origin does
not change its credential type. Its create request also sends hosted fields
such as `execution_tier` and `seed_from_run_id`, while the standalone service
snapshot above rejects unknown top-level fields and exposes no `/quote` route.
Use the standalone CLI or a version-matched gateway; do not point the desktop
at this service and assume hosted authentication and payloads are compatible.
See [hosted Evolve](HOSTED-EVOLVE-SUPER-INTELLIGENCE.md) and the
[account connector guide](OMNIROGUE-CONNECTOR-GUIDE.md).

## Configure OmniRogue S2S keys

This optional integration belongs to the **OmniSI application backend**, not the
standalone Evolve container. It enables the application to call OmniRogue wallet
and media APIs for a verified linked user. A standalone deployment using its own
model providers does not need these keys.

### Provision and inject credentials

Obtain a service key ID and secret registered by the OmniRogue operator for the
intended environment and permissions. Creating a random local secret is not
registration. The client source does not define a self-service issuance API or
the receiver's registration procedure; agree those with the operator.

| Application variable | Purpose |
| --- | --- |
| `OMNIROGUE_API_BASE` | Trusted upstream origin; defaults to `https://api.omnirogue.com`. Use HTTPS and an environment-specific allowlist. |
| `OMNIROGUE_S2S_KEY_ID` | Registered key identifier; configure explicitly for traceability. |
| `OMNIROGUE_S2S_SECRET` | Registered secret, injected only into the backend process. |

Validate configuration in your deployment entrypoint before starting the app:

```bash
set +x
: "${OMNIROGUE_API_BASE:?set the approved HTTPS upstream origin}"
: "${OMNIROGUE_S2S_KEY_ID:?inject the registered key ID}"
: "${OMNIROGUE_S2S_SECRET:?inject the registered secret}"
case "$OMNIROGUE_API_BASE" in
  https://*) ;;
  *) printf '%s\n' 'S2S upstream must use HTTPS' >&2; exit 1 ;;
esac
```

**Missing credentials do not fail closed in the current client factory.** If
`OMNIROGUE_S2S_SECRET` is absent, it returns `InMemoryOmniRogueClient`, a
deterministic fake. Require the HTTP client in production readiness checks and
verify a real upstream response. Setting these variables on the Evolve service
alone has no effect; that binary does not consume them.

### Wire contract and identity

`HttpOmniRogueClient` sends the following headers:

| Header | Value |
| --- | --- |
| `X-OmniSI-Service-Key` | `<key_id>:<secret>`; legacy client behavior sends the secret alone when no ID is set. |
| `X-OmniSI-Key-Id` | Key ID, when configured. |
| `X-OmniRogue-On-Behalf-Of` | Verified linked OmniRogue user ID. |
| `Idempotency-Key` | Stable operation key for reserve, settle, release, and generation requests. |

This is a shared-secret header contract, not HMAC request signing. Protect it
with TLS, private backend access, secret redaction, and receiver-side validation.
Never expose it in a browser, desktop renderer, MCP tool result, or source file.

Resolve the on-behalf-of user from a verified server-side account association;
do not copy an arbitrary user ID from an untrusted request. The S2S key identifies
the calling service, while the on-behalf-of identity determines the wallet.
An Evolve `org_id` is not an OmniRogue user ID.

The client calls `/api/internal/wallet/balance` with GET, and `/quote`, `/reserve`,
`/settle`, and `/release` under the same wallet prefix with POST. Start acceptance
with a read-only balance request for a dedicated test account through the
configured HTTP client. Confirm upstream authentication and user attribution
without logging headers. Run any reserve/settle/release test only against an
approved test wallet; a local fake response is not sufficient evidence.

Use one stable idempotency key per logical operation, scoped to its environment,
user and run. Retries of that operation reuse it; a different operation receives
a different key. Persist upstream reservation IDs and reconcile ambiguous
timeouts before sending a replacement operation. Do not assume every endpoint
implements identical replay semantics solely because the client sends a header.

### Rotate or revoke S2S credentials

Ask the upstream operator whether two keys can overlap. If supported, register
the replacement first, update the backend secret references, restart all callers,
verify the read-only probe, and then revoke the old key upstream. Otherwise use
a coordinated maintenance window. Updating the client environment alone does
not revoke a credential. The inspected client stores credentials on construction;
do not assume a running instance reloads them.

For suspected compromise, revoke upstream, stop affected integrations, reconcile
in-flight reservations, and investigate affected users and operation IDs. Keep
the audit record to key IDs and secret versions, never secret values.

## Set organization-wide budget policies

### Enforcement model and units

`evolve_budgets` provides shared admission limits for all callers with the same
verified `org_id`. PostgreSQL admission uses a conditional update inside the run
transaction, so concurrent submissions share the same counters. Each worker
must also reserve cost before making a provider call.

| Control | Enforcement |
| --- | --- |
| `max_daily_candidates` | Admission charges `generations × candidates_per_generation`. The population default is 8, or `spec.population.size`. |
| `max_daily_cost_cents` | Admission checks settled cost + outstanding run holds + the new run's estimate. |
| Per-run admitted hold | Comes from `estimated_cost_cents`, otherwise `spec.budget.max_cost_cents`, otherwise **zero**. |
| Per-call reservation | Worker must reserve a positive amount within the remaining run hold and settle no more than that amount. |
| Provider account limits | Separate provider-side control; configure independently. |
| OmniRogue wallet credits | Separate accounting system; no automatic cents-to-credits conversion is implied. |

The two daily admission conditions are:

```text
current_daily_candidates + requested_candidates <= max_daily_candidates
current_daily_cost_cents + reserved_cost_cents + new_run_hold <= max_daily_cost_cents
```

The window resets lazily once `window_start` is at least 24 hours old. This is
not a calendar-midnight reset or a sliding sum of the previous 24 hours.
**Outstanding holds carry across the reset.** Candidate admission charges are
not automatically refunded when a run fails or uses fewer candidates.

Use integer cents throughout the standalone service. At a 10,000-cent limit,
2,000 cents settled and 3,000 cents held leave 5,000 cents for new admission.
If the candidate limit is 500 and 480 have been admitted, a run requesting
3 generations × 8 candidates is refused even if money remains.

The API permits 1–100 generations, 1–256 candidates per generation, and a
nonnegative admitted cost up to 1,000,000,000 cents. Those are validation bounds,
not sensible enterprise defaults. Require realistic positive estimates in your
gateway/worker policy: a zero hold cannot fund a positive call reservation.

### Provision and change limits

Compose's migration variables provision one organization per invocation. For
additional organizations or a subsequent change, use an audited owner connection
to the **same database**. The application role can update counters but lacks
permission to change limits. There is no standalone budget-administration REST
route in this snapshot.

The following SQL is an operator template, run inside `psql` as the migration
owner; edit the organization and limit values before applying:

```sql
\set org 'org-example'
\set candidates 500
\set cents 10000
BEGIN;
SELECT set_config('app.org_id', :'org', true);
INSERT INTO organizations (org_id) VALUES (:'org')
ON CONFLICT (org_id) DO NOTHING;
INSERT INTO evolve_budgets (org_id, max_daily_candidates, max_daily_cost_cents)
VALUES (:'org', :'candidates'::int, :'cents'::bigint)
ON CONFLICT (org_id) DO UPDATE SET
    max_daily_candidates = EXCLUDED.max_daily_candidates,
    max_daily_cost_cents = EXCLUDED.max_daily_cost_cents,
    updated_at = now();
SELECT org_id, max_daily_candidates, max_daily_cost_cents,
       current_daily_candidates, current_daily_cost_cents,
       reserved_cost_cents, window_start
FROM evolve_budgets WHERE org_id = :'org';
COMMIT;
```

Record the old and new limits, organization, approver, reason, and effective
time. Update your provisioning configuration too, so a later migration job does
not restore older limits. Never reset counters or delete reservations to make
room for another run.

Lowering a limit does not revoke already admitted holds or stop running workers.
Setting the candidate limit to zero blocks new runs, since every valid submission
requests at least one candidate. For an emergency spend stop, also stop admission
at the gateway and prevent workers from starting new provider calls; reconcile
calls already in flight. Changing a budget is not cancellation.

### Worker accounting and recovery

All paths below are relative to `/api/evolve/runs/{run_id}`:

| Step | Request |
| --- | --- |
| Inspect accounting | `GET /lease` |
| Claim | `POST /lease` with `worker_id` and optional `ttl_seconds`; retain returned `lease_epoch`. |
| Heartbeat | `POST /lease/heartbeat` with the current epoch and optional TTL. |
| Reserve before a call | `POST /reservations` with `lease_epoch`, `amount_cents`, and optional TTL. |
| Settle | `POST /reservations/{reservation_id}/settle` with the epoch and `actual_cents`. |
| Finish | `POST /lease/finish` with the epoch and `outcome: "done"` or `"failed"`; include supported summary/model-call evidence. |

Default lease TTL is 120 seconds and reservation TTL is 300 seconds; accepted
TTLs are 10–3600 seconds. Heartbeat comfortably before expiry. A stale epoch
returns `409 lease_lost`; stop issuing calls and reconcile with the owning
service rather than retrying writes under a stale lease.

Settlement moves actual cost from the organization's held amount to settled
spend. Unused run funds remain available to that run until it finishes; terminal
runs release the remaining hold. Expired or unresolved reservations are charged
in full because their provider call may already have been billed. Expired leases
are reclaimed and fenced; the run is requeued, or failed after three expired
lease attempts. Unclaimed runs expire after 24 hours. Reclamation occurs during
run operations and through the periodic sweeper.

Reserve a conservative upper bound, enforce provider output limits, and reconcile
provider invoices with model-call records. The budget ledger cannot prevent
out-of-band provider spending or compensate for a worker that bypasses it.

### Policies supplied by the enterprise

This service implements organization admission and run/call accounting. It does
not supply a general policy API for monthly budgets, department allocations,
per-user limits, model allowlists, approval workflows, concurrency caps, or
automatic budget alerts. Enforce those in your gateway, worker scheduler, and
monitoring system, with the same policy on every submission path.

For example, an enterprise policy can set a 10,000-cent organization window,
require approval above a 500-cent run hold, permit specified providers, and alert
at 70% and 90% of settled-plus-held cost. Only the organization limit is native
to the documented service; the approval, provider, and alert controls require
your integration. Fail admission closed if that policy service is unavailable.

## Operate, recover, and upgrade

### Monitor and protect data

Monitor authenticated readiness, queue age, lease heartbeat age, stale epochs,
budget refusals, settled/held cost, sweep failures, and SSE disconnects. Use
organization and run IDs for correlation. Preserve spec digests, candidate
digests, model-call records, reservation IDs, and promotion events with an
appropriate retention policy; redact tokens and sensitive prompt material.

Use a non-owner, non-superuser database role without `BYPASSRLS`. Tenant queries
set `app.org_id` and `app.person_id` transaction-locally. The service checks for
unsafe role privileges and refuses those queries with `unsafe_database_role`;
do not work around that refusal by disabling RLS.

Back up PostgreSQL, including budget, lease, reservation, and outcome-event
tables. Retain the source/image revision, schema version, public JWKS, and secret
references separately. Test restoration in isolation with production provider
access disabled: restored leases must not cause duplicate external calls. Define
recovery time and data-loss objectives based on your deployment's needs.

### Upgrade and rollback

1. Pin matching service, CLI, worker, and schema revisions; review their changes.
2. Validate migrations and restore procedures against an isolated database copy.
3. Pause new admission and drain or deliberately stop workers, reconciling calls
   whose completion is uncertain before moving authority to another worker.
4. Back up, run the supported migrations as owner, and replace application
   processes using only application credentials.
5. Verify authentication, two-organization isolation, budget refusal, worker
   settlement, and SSE replay before reopening admission.

An older binary is safe to restore only if compatible with the migrated schema.
Restoring a database snapshot can discard later spend and outcome records;
reconcile that external state rather than treating restore as a cost refund.

Promotion and rollback endpoints record active/canary candidate choices. Your
consumer must apply those records to real traffic or artifacts. A `promote` or
`rollback` response alone does not prove a production deployment changed. Bind
human approval, when required, to the exact candidate and destination; verify
the consuming application after the operation.

## Troubleshooting

| Symptom | Check and action |
| --- | --- |
| Healthy `/healthz`, failed reads | Check authenticated readiness, database connectivity, schema, and runtime role privileges. |
| `401 invalid_token` | Verify RS256, `kid`, mounted JWKS, issuer, audience, expiry, clock, and the environment issuing the token. |
| `403 tenant_header_mismatch` | Remove spoofed/stale identity headers; fix the authenticated proxy's mapping. |
| `404 run_not_found` | Check UUID and organization. Cross-organization reads intentionally do not reveal the run. |
| `422` on create | Check target, numeric bounds, spec size (256 KiB canonical limit), baseline size (64 KiB), and unknown top-level fields. |
| `429 budget_exhausted` | Inspect both candidate and cost counters plus outstanding holds. Reduce/defer work or obtain an authorized limit change. |
| `409 lease_lost` | Stop the stale worker's writes/calls and inspect the current lease; do not overwrite its epoch. |
| `503 unsafe_database_role` | Use the RLS-bound application role rather than an owner/admin connection. |
| `503 evolve_schema_missing` | Check the pinned migration set. Discover import additionally needs the Discover tables. |
| Run stays queued | Confirm an actual worker is installed and able to authenticate, claim leases, and reach providers. |
| SSE repeatedly disconnects | Check token expiry, ingress buffering/timeouts, and replay using a fresh token and `Last-Event-ID`. |
| S2S reports plausible data without upstream traffic | Check for the in-memory fallback and enforce production HTTP-client readiness. |
| S2S rejects a request | Check registered key/version, HTTPS origin, on-behalf-of mapping, receiver permissions, and redacted upstream error code. |

## Acceptance checklist and references

Before treating a deployment as ready, retain evidence from an isolated test
organization and an approved small run:

- [ ] Source/image revisions and schema are pinned; migration completed.
- [ ] TLS, authenticated database readiness, and backups/restoration work.
- [ ] Missing, expired, wrong-audience, and unknown-key JWTs fail.
- [ ] A second organization cannot read the first organization's runs.
- [ ] Worker execution produces real candidates and durable evaluation evidence.
- [ ] Candidate and cost limits reject excess work, including concurrent admission.
- [ ] Reservations settle; stale leases are fenced; recovery preserves accounting.
- [ ] SSE reconnects and replays; promotion records are distinguished from deployment.
- [ ] Optional S2S uses the HTTP client and verified account mapping; rotation and
      receiver-side revocation have an agreed procedure.
- [ ] Policy owners understand which controls require their gateway or workers.

Source references for the pinned backend contract:

- [Self-hosting package, Compose, Dockerfile, migration script, and schema](https://github.com/omnirogue/omnidots-cloud/tree/d9608464b788f0aa858c24aa7edeedc65b09a9d8/oss/omnisi-evolve).
- [Service authentication, routes, PostgreSQL enforcement, and lease accounting](https://github.com/omnirogue/omnidots-cloud/tree/d9608464b788f0aa858c24aa7edeedc65b09a9d8/rust/crates/omnisi-evolve-service/src).
- [Standalone CLI contract](https://github.com/omnirogue/omnidots-cloud/blob/d9608464b788f0aa858c24aa7edeedc65b09a9d8/rust/crates/omnisi-evolve-cli/src/lib.rs).
- [OmniSI S2S configuration](https://github.com/omnirogue/omnidots-cloud/blob/d9608464b788f0aa858c24aa7edeedc65b09a9d8/src/omnidots/settings.py)
  and [HTTP client, headers, and fallback behavior](https://github.com/omnirogue/omnidots-cloud/blob/d9608464b788f0aa858c24aa7edeedc65b09a9d8/src/omnidots/omnirogue_client.py).
- [Desktop hosted-client contract](../../src/main/runtime/evolve/hosted-evolve-client.ts),
  [hosted Evolve guide](HOSTED-EVOLVE-SUPER-INTELLIGENCE.md), and
  [unified MCP reference](UNIFIED-MCP-REFERENCE.md).
