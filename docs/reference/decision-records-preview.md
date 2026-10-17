# JEV decision records preview

The default-off CLI preview adds versioned advisory observations and calibration to the existing
recipe JSONL format. No action, routing, review, routine or completion authority is added.
`decision-recipe-registry.mjs` resolves archived questions, model pin, admission checks and
interpretation policy by explicit recipe version. Preserve old entries when adding versions.
The six v1 question hashes are unchanged; `trace_review` is reserved and cannot execute.
The desktop evaluator shares the refactored definitions and explicitly selects v1; its behavior
is unchanged. No desktop UI, RPC or installed bundle is replaced.

Four new commands require `JEV_DECISION_RECORDS_ENABLED=1`:

```sh
node jev-decide.mjs registry
node jev-decide.mjs decide-record packet.json preview-observations.jsonl
node jev-decide.mjs record-outcome labelled.json preview-observations.jsonl
node jev-decide.mjs calibration preview-observations.jsonl
```

Use the existing CLI bundle build or its documented source Node/type-transform setup.
The caller provides its authorized `TYPESAFE_API_KEY`. The new inference path honors
`JEV_DECISIONS_DISABLED` and `OMNI_STRUCTURED_DECISIONS_KILL` when nonempty and not `0` or
`false` (case insensitive), including immediately before transport. Legacy kill behavior is
unchanged. One five-second deadline includes credential resolution; no retry or silent fallback.
The existing production provider validates the pinned result. The opt-in fetch hook supplies
`User-Agent: OmniConsole-JEV-Decision-Records/1`; a returned vendor request ID is retained.

## Packet and authority

`packet.json` has exactly `recipeId`, `recipeVersion`, `state` (the recipe's allowed fields),
and `context`. Only `manual_review` is implemented. Other surfaces require their own adapter
and versioned contract before being accepted. Options and human-choice events are deferred.

```json
{
  "surface": "manual_review",
  "scopeId": "11111111-1111-4111-8111-111111111111",
  "subjectId": "22222222-2222-4222-8222-222222222222",
  "sourceRevision": "<64 lowercase hex SHA256 characters>",
  "checks": [
    { "id": "scope_authorized", "status": "pass", "evidenceDigest": "<SHA256>" },
    { "id": "source_current", "status": "pass", "evidenceDigest": "<SHA256>" },
    { "id": "input_minimized", "status": "pass", "evidenceDigest": "<SHA256>" }
  ]
}
```

UUIDs are opaque; never encode customer identifiers. Checks are **operator attestations**,
not authenticated authorization or a redaction implementation. Their closed status is pass,
fail or unknown; pass requires a digest. Fail/unknown skips inference and records unavailable
with empty answers. No model answer can supply a pass. Deterministic source permissions,
revision lookup and redaction must be implemented by a future owning adapter before private
or customer-data use. Regex matching alone would not prove complete redaction.

The record contains recipe/version/question hash, policy version, scope/subject, revision/check
digests, model, usage, timing, closed answers and safe failure category. Input text stays outside
the ledger. `inputDigest` hashes JSON `{recipeId, state}` with state projected in recipe field
order. This matches the desktop wrapper when its input uses that order; desktop raw-state
ordering can still differ. Never join differently ordered JSON as equivalent without an explicit
migration. Digests are unsalted: they permit guessed-text confirmation and are **not redaction**.
Before customer data, add a scope-keyed HMAC and verified source/redaction adapter under separate
review. Current evaluation recommendation is public, non-customer frozen retrieval packets only.

## Independent labels and paired comparisons

`labelled.json` has `outcome` and `provenance`:

```json
{
  "outcome": {
    "observationId": "<observation UUID>",
    "labels": { "route": "how_to", "priority": 0, "sensitive": null },
    "baselineElapsedMs": null,
    "baselineCorrect": null,
    "workflowElapsedMs": null,
    "baselineWorkflowElapsedMs": null,
    "source": "human"
  },
  "provenance": {
    "method": "human_attested",
    "evidenceDigest": "<SHA256 of evidence record>",
    "inputDigest": "<copy from this observation>"
  }
}
```

Method/source pairs are `human_attested`/`human`, `verified_record`/`verified_outcome`, and
`model_reference`/`model_reference`. The CLI authenticates neither the operator nor blinding.
Freeze the rubric and capture labels separately before showing predictions where possible;
a future label-commitment flow remains proposed. Labels must cover all question IDs but may be
null individually. Score labels are integer rubric levels; Noul labels are binary. Model-reference
agreement is reported separately, never included in independent quality totals. A human click
or JEV post-run grade is not an independent label. Missing timings stay null. Total workflow time
includes preparation, queueing, fallback, adjudication and label overhead; losses remain negative.

Calibration splits recipe/version/hash/model/policy/schema, surface, scope and legacy versus
contextual records. It exposes distinct subjects, repeated subject/input pairs, failure reasons,
unlabelled and unattested coverage. Per-question results report five playbook probability bands,
counts, Wilson 95% intervals, Noul Brier, Choice accuracy/multiclass Brier, Score MAE and ranked
probability score. Small cohorts also expose closed prediction/label pairs. Confidence is never
used as frequency. Intervals assume independent samples; correlated or selected items weaken them.
The display threshold of 50 is not an activation criterion.

The report includes paired baseline accuracy delta, inference latency and total-workflow savings,
slower-case counts and all-attempt median latency. Partial labels contribute per-question metrics
but exclude the case from complete-case quality/disposition comparisons. Unavailable predictions
are missing, not negative labels; a fully labelled attempt with no prediction counts as unsuccessful
in the service comparison with a baseline. Legacy disposition thresholds remain uncalibrated;
conditional advisory error is shown only for fully labelled successes. No consumer is added.
Every report has `deploymentVerdict: inconclusive`; no threshold fitting or automatic promotion.

## Persistence and errors

Use a **fresh** ledger for this preview. Enhanced writes refuse existing legacy observations;
calibration can read them separately, marking inferred metadata and excluding unattested labels.
This revision's legacy `summary` accepts enhanced outcomes; older installed bundles do not.
Do not mix writers or transports: the host identity is implicit in the owning file, and Lane A's
30-second retrying trial is a different cohort from this five-second/no-retry CLI.

Inference occurs before the exclusive adjacent `.lock`; append re-reads and validates history.
Lock metadata identifies pid, host and start time. There is no stale-lock takeover or automatic
retry. After interruption, reconcile the observation ID and verify the old writer is gone before
manual recovery. Files default to 0600; use a private writable directory and rotate before 16 MiB.
Truncated, oversized, duplicate, orphaned or incompatible history fails closed. A failed fsync or
cleanup can leave persistence uncertain: inspect the ledger before retrying.

Exit 0 returns a successful command; exit 2 returns an **appended unavailable observation**.
Exit 3 returns a closed rejection code with `recorded: false`; exit 4 returns a closed persistence,
lock or ledger code with `recorded: null`. Arbitrary errors or JSON fragments never enter stderr.
An unavailable response does not imply safe, false, approved or completed.

Future routine, dependency, option-ranking and human-review adapters must retain execution-owner,
principal and revision fences, append evidence before display and keep current workflows usable
on JEV failure. No new service or scheduler is needed. Required GitHub checks verify contracts;
natural labels and measured baselines are needed to establish benefit. Canonical rules:
[JEV playbook](https://example.slite.com/app/docs/AEbNPsI1HibRtt).

## Queue triage build preview

`JEV_QUEUE_TRIAGE_ENABLED=1` separately opts into two library capabilities under
`config/scripts/`; it defaults off. Both inference kill switches still apply. With the flag
unset, suggestion, parity and human-choice entry points are inert and the legacy registry
listing is unchanged. The archived `queue_presentation_triage@1` Choice and
`lander_group_comparison@1` Score recipes pin `jev-1.13.0`; existing recipe wording is unchanged.

`reconcileQueuePresentation(page, decisions, options)` requires an explicit
`scope: 'presentation_only'`, page id/title/question/revision/evidenceRefs and recorded decision
id/revision/resolution/timestamp/sourceLink. Only an exact-scope or fully superseded subset
answer with confidence at least 0.9 and a supplied matching evidence link can suggest
`clear_from_queue`. Missing evidence, new scope, uncertainty and unavailable inference keep
it visible. The confidence cutoff is an uncalibrated display rule, never authority.

`compareLanderGroup(group, options)` accepts `scope: 'draft_only'`, a group id and a list of
items with id/title/price/ctaText/primaryLink. Prices must be explicit comparable strings
including currency and terms. Deterministic parity requires known, consistent prices, CTA
text and HTTP(S) targets across every item; mismatch reasons remain per item. After parity,
per-candidate scores rank the whole group. Ties, low confidence or any unavailable candidate
leave no proposed default and preserve normal review of every item. The entire group (or
reconciliation attempt) shares a deadline of at most five seconds, with no retries.

Options supply the execution owner's provider, private ledgerPath and optional environment
and timeoutMs. No credential lookup, live source adapter, UI, queue-removal callback, scheduler,
RPC or service is installed. The caller must authenticate the principal and verify source
permissions, current revisions, eligible scope and minimized input before calling. These
explicit scope tags are caller assertions, not model-derived authorization. Money, ads control,
customer-irreversible, deploy and case-close scopes are unsupported. Use only public/synthetic
inputs until a separately reviewed source/privacy adapter exists.

Suggestions append an ordinary advisory observation with a version-1 `queueTriage` extension
before returning its observationId. Raw titles, questions and resolutions stay out of the ledger;
opaque IDs, revision/input digest, matched evidence metadata and draft rankings are retained.
`confirmQueuePresentation` accepts confirmed/rejected; `confirmLanderGroup` accepts confirmed
with the proposed chosenId or deferred_to_manual with chosenId null. Each explicit human event
requires observationId, actor, startedAt and endedAt (ISO timestamps). It appends a version-1
`human_choice` row through the existing locked JSONL writer, with recipe identity, subject,
evidence/disposition, input binding and elapsedMs. Duplicate choices are refused. A click is
not an independent calibration label. Existing outcomes and historical rows are not rewritten;
use a fresh preview ledger because older readers do not recognize human_choice rows.

This is advisory-only, one-click-required tooling: even confirmation only records the choice.
Nothing removes a queue item, selects a live lander, approves, publishes, sends or launches.
Actual UI and queue-removal wiring are explicitly out of scope. Deployment verdict remains
inconclusive and is never automatically promoted.
