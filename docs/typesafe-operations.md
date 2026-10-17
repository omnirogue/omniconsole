# Optional structured decisions

Typesafe supplies fixed-choice decisions, ordered scores and yes/no probabilities. It does not generate arbitrary JSON, establish factual truth, grant permission or mint completion receipts. The provider-neutral contract and local validators live in `src/shared/structured-decisions.ts`; the Typesafe transport is isolated in `src/main/structured-decisions/typesafe-provider.ts`.

## Host configuration

Copy the shape in `config/structured-decisions.example.json` to `structured-decisions.json` in the runtime's existing user-data profile. The example is globally disabled. A missing, unreadable, oversized or invalid file also disables the capability. The runtime reloads the file on each admission and during in-flight decisions; no app restart is needed.

Set `enabled: true` only on an authorized host. Keep all `orchestration.*` entries `shadow` (the service mechanically rejects live orchestration even if the file says `live`). `advertising.routine` and `routine.structured` permit live recommendations/classifications only for routines which explicitly opt in. Optional `routines` entries can further disable or shadow a particular routine; they cannot opt a legacy routine in by themselves. Do not include internal `valid` metadata in the file.

The key is resolved in main process from `TYPESAFE_API_KEY`, or its existing private entry in `~/.config/omni/connections.env`. Never put the key in routine settings, prompts, report files, repository configuration or renderer storage. Example environment syntax is `TYPESAFE_API_KEY=<secret-from-existing-vault>`; this is documentation, not a second secret file.

## Immediate kill switch

Set `killSwitch: true` or `enabled: false` in the profile's `structured-decisions.json`. In-flight inference is aborted and new admissions stop. The authenticated runtime RPC `structuredDecision.disable` atomically persists both settings and aborts pending inference. `OMNI_STRUCTURED_DECISIONS_KILL=1` is a startup/environment override. Per-capability or per-routine `mode: off` narrows the shutdown scope.

Disabling Typesafe does not roll back an already submitted advertising mutation. Its original durable action record remains available for independent readback; an uncertain send must be reconciled, never blindly retried. Existing normal sessions and routines with structured output Off continue on their original path.

## Enable another routine

In the routine editor, choose Structured output → Typesafe. Use the classification contract for advisory report verdict/severity, or the advertising contract with an explicit supported company and exact advertising account. Save on the routine's execution host. The host must advertise `automation.structured-output.v1`; old/unsupported hosts refuse opt-in rather than silently losing it. Direct SSH-host routines are not evaluated locally.

Classification interprets a complete bounded report only after the owning host confirms a genuine final assistant response from the exact native routine turn. Raw terminal captures, provider errors, stale turns, and oversized, truncated or missing reports cannot authorize structured evaluation. A PASS means the report claimed success, not that the actual work is verified; classification has no action execution button. Advertising uses the same final-response admission gate. Its reports supply only typed target selectors; authenticated native observations supply metrics, collection/measurement timing, hierarchy and budgets. Model output never supplies permissions or source metrics.

Advertising can recommend KEEP_RUNNING, TURN_ON, PAUSE, INCREASE_BUDGET, DECREASE_BUDGET or NO_ACTION. Only PAUSE/TURN_ON have an execution path. Accounts covered by the existing backend use its signed preview, explicit per-action human confirmation, durable idempotency fence and source readback.

The exact Sal-only OldACS local provider instead uses a separately authorized `local-human-action.v1` preview and local native-state observation receipt through those same action controls and coordinator. Its distinct private action grant is absent/default-off until reviewed provisioning; a read grant or Typesafe recommendation cannot authorize a write. Each ad/ad-set status change still requires actual human approval of the exact current preview ID/revision. There are no campaign or budget writes, no agent APPLY fallback, and no retries of uncertain sends. Its receipt proves only the independently observed target state with unchanged observed controls: causality, delivery and profitability remain unproven. Neither provider's action receipt is a Done When/completion receipt or permission for another action. See [local Meta status actions](reference/local-meta-status-actions.md) for the exact authority, recovery and evidence limits.

Budget decisions remain recommendations; they do not circumvent Sal's per-increase permission or profitable-budget protection.

## Evidence and failure handling

`structuredDecision.status` reports sanitized settings, credential presence (never value), and the recent bounded telemetry ring. Records are private, main-owned, schema-checked files in the profile's `structured-decisions` directory. Telemetry contains controlled identifiers, durations, bounded failure codes, model, usage and comparison values; it excludes prompts, raw state, credentials, raw provider errors and receipt bodies.

The default total inference deadline is five seconds, with at most one retry for a transient provider failure. Shadow work has a bounded queue and concurrency; overflow is dropped rather than delaying ordinary work. Ordinary authoritative results never wait for or consume shadow results. Telemetry keeps the latest 256 admitted events in memory and persists snapshots at most once per second during traffic; a restart can lose events since the last snapshot, so this is diagnostic sampling, not a billing or audit ledger. Known usage covers successful returned responses; cancelled/failed/retried requests can have unreported billing.

The bounded live experiment driver is `runDecisionExperiment` in `decision-experiment.ts`. It requires explicit `enabled` and `execute` opt-ins, uses six fixed synthetic cases, batches Choice/Score/Noul, makes at most six sequential calls with no retries, and emits a content-free measurement report. It is not representative production correctness proof. Do not substitute it for the repository's required GitHub checks or run test suites on Sal's Mac/fleet.

See [the capability roadmap](typesafe-capability-roadmap.md) for per-capability ground truth, missing baseline measurements, promotion criteria and the distinction between agreement, correctness and actual cost savings.
