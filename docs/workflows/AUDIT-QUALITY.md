# Comparing audit routes

The audit benchmark compares three routes on the same frozen source corpus, task and references: one capable direct response, independent chunk readers followed by one merge and report, and the full audit pipeline. Each route uses the existing durable call executor, bounded retries and slots. The full arm calls `runAuditProgram`; this kit adds no execution engine or production default.

The bundled case `audit-setup-development-v1` contains two synthetic conversation sources. It is development data, not a held-out evaluation. Fixture responses deliberately exercise unsupported quotations and cannot measure model quality. No private transcript is accepted by this command.

```sh
# No provider calls: exercise all three routes with synthetic native envelopes.
npx --yes tsx config/scripts/workflows/benchmark/run-audit-quality.ts --out /tmp/audit-quality-fixture

# Explicit live opt-in: all roles use this same capable Claude model at high effort.
# Uses the existing configured local Claude login and diagnostic launcher.
npx --yes tsx config/scripts/workflows/benchmark/run-audit-quality.ts \
  --live --model <pinned-Claude-model> --repetitions 3 --out /tmp/audit-quality-live
```

The live adapter is the existing `diagnosticCouncilLaunch`. Account isolation and model attribution are not certified; reported model IDs and requested seats remain in the observations. The command does not change credentials, routing or concurrency settings. Live trials use the same frozen-evidence tools across all arms. Supply a model that is strong enough for a meaningful direct baseline. No live comparison was run when adding this instrument.

Before the first call, `manifest.json` freezes the case, source hashes, task, references, model/effort, repetitions, primary outcome and caps. Each trial permits 64 distinct calls, up to 192 attempts including retries, 20 minutes, and concurrency three. These are equal caps, not equal expenditure. Arm order rotates between repetitions. Direct champions are saved independently and never shown to other arms. Reports retain failed trials and include total observed wall time and every durable attempt, covering readers, merge, novelty, verification, judging, synthesis, critic and retries. Missing token totals and all prices remain `null`; this instrument cannot establish a dollar-matched comparison.

The primary outcome is independently accepted distinct useful mechanisms with verified quotations. Validity, usefulness and novelty are labelled separately; a quote match or agreement score is not a truth label. Deterministic checking re-reads registered sources for every arm, but cannot prove a quotation's interpretation, usefulness, or originality.

Give a reviewer the frozen task/corpus plus `blind-packets.json` and `adjudications.pending.json`, withholding `private-route-map.json`, observations, raw results and prior rankings. Packets are ordered by random sample ID and contain no model, route or verifier verdict. Writing style can still reveal the route. For every finding, record `valid`, `useful`, `novel`, a stable `mechanismId` for duplicates, and an evidence reference supporting the assessment. Unknown labels stay `null`. Failed runs also need assessment records; preserve any partial findings and leave unresolved judgments unknown. Fully assessed failures earn zero useful and novel outcomes, even when they left a partial answer. The supplied `independent` flag is provenance, not mechanically proven independence.

```sh
npx --yes tsx config/scripts/workflows/benchmark/run-audit-quality.ts \
  --manifest /tmp/audit-quality-live/manifest.json \
  --observations /tmp/audit-quality-live/observations.json \
  --adjudications /tmp/audit-quality-live/adjudications.reviewed.json \
  --out /tmp/audit-quality-live/reviewed-report.json
```

Scoring refuses missing planned trials, mismatched input hashes and ambiguous labels. Before complete independent labels, quality and paired gains remain unknown. Reviewed fixture trials remain `fixture-behavior-only`. Live labelled results report paired descriptive differences against the saved direct baseline; one development case cannot establish broad superiority. Keep the direct champion when the evidence cannot distinguish it from synthesis. No score automatically changes a default.

To add representative cases, call `runAuditQualityArm` with a frozen `WorkflowProgramSnapshot` through the same durable trial port. Freeze a new case version and separate development from held-out material before collecting final labels. A source-based audit should retain speaker/clipping provenance and use original material when omitted context matters. Preregister the task mix, expected repetitions, assessor and the smallest meaningful improvement before running a larger study; use the workflow-quality skill's paired scorer for task-level uncertainty rather than treating repeats of this one case as independent problems.
