# JEV advisory decisions and measurement

Six versioned recipes extend the existing TypeSafe provider: support triage, advertising
copy review, work routing, evidence review, retrieval review and business lead fit.
Every recipe sends Choice, Score and Noul together. The CLI and library return suggestions
only; actions is always empty. The desktop runtime flags, existing approval systems,
GitHub verification and advertising numeric policy remain authoritative.

## Run

Node 24.13+ is required. The manual Typesafe Evaluation workflow with
suite=decision_recipes packages a standalone jev-decide.mjs alongside its observations.
No desktop restart, Python dependency, daemon, scheduler or new API service is needed.
Use the bundle on the host that owns the input. Folder workspaces are supported.
The caller's environment supplies TYPESAFE_API_KEY from its existing authorized vault.
The bundle never creates an environment file or copies credentials.

    node jev-decide.mjs list
    node jev-decide.mjs decide support_triage state.json observations.jsonl
    node jev-decide.mjs summary observations.jsonl

The state JSON for support_triage is {"message":"How do I export a report?"}.
List exposes the exact allowlisted fields and questions for every recipe. Only send the
minimum authorized redacted evidence; no tokens, customer identifiers or full transcripts.
There is no credential discovery, tenant impersonation or cross-company connector access.
Run invocations serially per ledger. Rotate a ledger before 16 MiB. Records are appended,
never silently overwritten; a damaged ledger or duplicate outcome fails summary.

The module exports buildRecipeRequest and evaluateRecipe for caller integration. Use
the existing TypeSafeDecisionProvider, which validates schemas, probability distributions,
model identity, response bounds and redirect policy. The API receives no labels, timestamps
or prior answers from the measurement channel. A call has a five-second deadline with no
retries or fallback model. Set JEV_DECISIONS_DISABLED=1 to disable CLI inference.
Unavailable results return exit code 2, empty answers and review disposition; use the
existing human or generative workflow. Never interpret unavailable as a negative answer.

## Desktop trial workflows

The Workflow menu offers three separate read-only trials: JEV Ad Check (draft copy and
approved offer facts), JEV Evidence Check (one claim and source excerpt), and JEV Work
Triage (one redacted request). Each runs the corresponding versioned recipe on this
desktop. Council, Discover, and Build + Review remain available as their own workflows.
The trials return advice only and do not launch another workflow or change project state.

The desktop uses the same local credential resolver as structured decisions. Configure
`TYPESAFE_API_KEY` in the desktop process environment or in
`~/.config/omni/connections.env` with owner-only file permissions. A missing key, timeout,
disabled flag, or invalid provider response shows an unavailable result and sends no
action. `JEV_DECISIONS_DISABLED=1` and `OMNI_STRUCTURED_DECISIONS_KILL=1` disable these
trials. Never paste a key into the trial form.

The result view shows the returned model, latency, input hash, three answers and an
optional manual comparison note. This note stays in the dialog and is not an automatic
split test or an outcome label. Use the CLI observation and independently adjudicated
outcome flow below to measure quality and speed. The first synthetic evaluation of these
recipes was incomplete: two evidence-review cases returned `invalid_response`. Keep
Evidence Check advisory and route any unavailable result to the existing review path;
the cause of those two failures has not yet been established from the retained artifact.

Advisory and review are UI triage hints, never action permission. The 0.9 confidence and
0.1 sensitive thresholds are conservative starting points, not measured calibration.
Financial writes, budget/status changes, customer replies, account changes, releases,
shell commands and automatic dispatch are outside this adapter. Noul does not have a
separate confidence value. Score is ordinal on a zero-based rubric, not a quantity,
duration, profit estimate or probability.

## Measure speed and quality

Each inference appends an opaque observation ID, recipe/question version/hash, actual
returned model, all-attempt latency, status, closed answers and reported usage. It omits
source text, customer IDs, credentials and raw provider errors. Baseline times and quality
remain null until the independent outcome channel supplies them.

Record an independently adjudicated label and measured existing-path times:

    node jev-decide.mjs outcome outcome.json observations.jsonl

Outcome JSON has exactly these fields:

    {
      "observationId": "<ID from a decision>",
      "labels": {"route":"how_to","priority":0,"sensitive":0},
      "baselineElapsedMs": null,
      "baselineCorrect": null,
      "workflowElapsedMs": null,
      "baselineWorkflowElapsedMs": null,
      "source": "human"
    }

Source is human or verified_outcome. Never populate a missing measurement with an
estimate. Use paired runs on the same evidence and include queue, fallback and review
time in workflowElapsedMs; use the same start/end boundaries for the existing workflow.
This file is a trusted operator input, not customer text or a model-produced grade.

Summary reports failures, review rate, complete-case correctness, ordinal mean absolute
error, Noul Brier score, paired accuracy delta and latency/workflow savings. A positive
saving means faster; a negative value means slower. Failed decisions count as wrong when
labelled. Score correctness uses a fixed 0.6-level tolerance. Latency savings use successful
matched inference pairs; failures remain separately counted and included in all-attempt
latency. Workflow savings require both observed workflow durations.

For a repeatable synthetic comparison, run the existing manual Typesafe Evaluation workflow
on an exact published main-next commit with suite=decision_recipes and split=all. It uses
the production provider, a pinned Gemini 3.8 Flash comparator, predeclared cases/labels,
counterbalanced order, bounded requests and four batching comparisons. It does not use
customer traffic. A fast synthetic response is not measured production throughput, CSAT,
revenue uplift, saved human time or calibrated accuracy.

## Reuse and scope

Inspired by the MIT-licensed kenhuangus/jev-usecases catalog:
https://github.com/kenhuangus/jev-usecases . No upstream code or dependency is vendored;
the existing OmniConsole transport and evaluation infrastructure are reused. The upstream
auto/confirm/human/block policies are examples, not estate permission grants.

The natural next integrations are read-only support inbox suggestions, pre-publication
offer checks, optional retrieval ordering and capability suggestions. Hook these into
existing callers with independent outcome logging before replacing a production path.
Deterministic arithmetic, receipt validation, dates, budgets and exact rules should stay
in code: adding a model to those checks would make them slower and less reliable.
