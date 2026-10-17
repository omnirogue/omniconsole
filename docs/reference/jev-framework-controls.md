# JEV controls and the improvement lab

The selected runtime owns JEV configuration. Settings → Git & Source Control now contains **JEV on the selected host**, a status refresh, and **Ask JEV once** for an advisory task route. A disconnected or older host reports unavailable; it does not silently target another host. These controls require a build containing this change.

```sh
omni jev status --json
omni jev off --json
omni jev on --json
omni jev request --file request.json --jev request --json
```

`request.json`:

```json
{
  "recipeId": "evidence_review",
  "state": {
    "claim": "The fictional launch checklist includes a rollback owner.",
    "source": "Fictional checklist: owner Mira; rollback owner Jo; staging checks complete."
  }
}
```

The other recipes are `work_routing` with `{task}`, `advertising_review` with `{copy, offer}`, `support_triage` with `{message}`, `retrieval_review` with `{query, passage}` and `lead_fit` with `{lead, criteria}`: the six archived v1 recipes in `config/scripts/decision-recipes-v1.mjs`. Each field is 1-6000 characters and the state at most 12 KB. These return bounded typed readings only. They neither start work, answer a customer, contact a lead nor publish advertisements. The parked desktop trials keep their three recipes.

`jev-request-record/1` provides a request ID, input hash, recipe version, requested/effective mode, native confidence provenance, actual returned model, answers, usage and elapsed time where available. Every result, including `--jev off`, host-off and unavailable results, is kept as `jev-request:<request_id>` in the selected runtime's private structured-decision records, and the output adds `storage: {status, key}`. A failed write reports `storage.status: failed` with `reason: record_write_failed`; the result is still returned and the write is not retried. Source text is not added to this result record.

`support_triage`, `retrieval_review` and `lead_fit` need a runtime that advertises `jev.request.v2`. An older runtime gets an update-required refusal before any request is sent; the three earlier recipes still run there, without a stored record.

The file is on the CLI machine. A local CLI can select a paired runtime with the ordinary `--environment` flag. Forwarded SSH/WSL shells reject file requests because their working directory belongs to a different machine; the CLI must never read a colliding local file as remote evidence. Status and switch commands still use normal runtime targeting.

## Reusable rubrics for ordinary agents

The public CLI uses the same library as **Build + Review → Rubric → Edit → Save rubric** and the Find/Improve options picker. It adds no separate rubric store or generation workflow:

```sh
omni jev rubrics list --json
omni jev rubrics save --file rubric.json --json
omni jev rubrics evaluate --file evaluation.json --json
# On an SSH/WSL execution host, forward the contents rather than a host-local path:
cat evaluation.json | omni jev rubrics evaluate --input-stdin --json
```

`rubric.json` contains `{"name":"Concise reply","kind":"reply","instructions":"- Answers the supplied question directly\n- States unsupported claims as uncertain"}`. The name is limited to 80 characters and instructions to 6000. Saving an existing custom name requires `--replace`; built-ins cannot be overwritten. Settings → Rubrics and the Build + Review picker apply the same rules to their saves and imports. Saving updates the UI library, while earlier runs keep their frozen criteria.

`evaluation.json` contains:

```json
{
  "rubric": "Concise reply",
  "task": "Explain the supplied fictional refund policy in two sentences.",
  "response": "The supplied policy allows a refund within 14 days. Contact support with the receipt.",
  "evidence": {
    "status": "verified",
    "text": "Fictional policy: refunds within 14 days; support requires the receipt."
  }
}
```

Use a library value from `list` or a unique rubric name. Task and evidence text limits are 6000 characters each; response is limited to 30000, and JSON input to 48 KB. Evidence is supplied by the caller: `verified` is a declaration, not verification performed by JEV. Declared `missing`, `stale`, `conflicting` or `unverified` evidence returns `unknown` before a provider call. Omitted evidence limits evaluation to supplied task and work and cannot verify external claims.

Callers must pseudonymize names and identifiers and supply only relevant evidence. Known secrets, emails and phone numbers are scrubbed before inference; the record marks redaction and binds both source and evaluated rubric digests.

Evaluation freezes the selected criteria and uses a direct advisory Score call. It generates no candidates, performs no action and invokes no model escalation. `verdict` means advisory scores were returned, not an approved action or independently proven quality. Unknown, voided and provider unavailable results stay explicit. Results include storage status and a key in the selected runtime’s existing structured-decision records; retain JSON output when needed. Earlier runs remain unchanged when the library is edited.

Per-request `--jev off` makes no provider call. Other modes respect host and environment switches; `request` is the default and never changes the master switch. Runtime-owned credentials are used. All three commands negotiate `jev.rubrics.v1` and tell the caller to update an older runtime rather than falling back to raw settings writes or another model. Local `--file` reads use the CLI machine; forwarded SSH/WSL shells require bounded `--input-stdin`, so remote file paths never resolve against the controller.

## Records and outcomes: the JEV ledger

Each runtime keeps one append-only ledger beside its private records, under `<userData>/structured-decisions/jev-ledger/`. The directory is 0700 and its files are 0600. Every native JEV call attempt appends one `jev-call/1` line to `calls.jsonl`. The main process is the only writer and serializes its appends. When the next line would take the file to 16 MiB, the file is first renamed to `calls-<UTC time>.jsonl`. Independent labels go to `outcomes.jsonl` as `jev-outcome/1` rows. The row shapes follow the shared ledger row contract v1, which jev-lab's loader also reads.

Rows hold hashes only. A row keeps hashes of the state and of the question set, the question ids, and each closed answer with its full probabilities. It never keeps question legends, the vendor `confidence` field, or any task, response, evidence, prompt, brief, passage or message text. `ref` names a built-in rubric or recipe by its fixed id. A saved rubric's name is free text, so its row keeps `saved:<sha256 of the name>` instead. `model` is the model that answered, and `null` when no answer came back.

| caller                                                                                           | path                                                                                            | transport, deadline                                 | record_key                 |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | --------------------------------------------------- | -------------------------- |
| `jev.rubrics.evaluate`                                                                           | `omni jev rubrics evaluate`, Settings rubric trial                                              | `advisory`, 5000 ms                                 | `jev-rubric:<request_id>`  |
| `jev.request`                                                                                    | `omni jev request`, Settings "Ask JEV once"                                                     | `advisory`, 5000 ms                                 | `jev-request:<request_id>` |
| `jev.trial`                                                                                      | parked desktop trial workflows                                                                  | `advisory`, 5000 ms                                 | `jev-call:<id>`            |
| `next-steps.judge`, `next-steps.doneness`, `next-steps.improvement`                              | next-step ranking and risk, doneness, Keep going                                                | `direct`, 8000 ms                                   | `jev-call:<id>`            |
| `session-steward`, `session-steward.archive`, `session-steward.organize`                         | safe Yes, Tier 2 archive review, refile/retitle/merge                                           | `direct`, 8000 ms                                   | `jev-call:<id>`            |
| `session-owner`                                                                                  | `omni session find-owner`, assign, session-prep reuse                                           | `direct`, 8000 ms                                   | `jev-call:<id>`            |
| `session-prep.gate`                                                                              | prepared-prompt gate                                                                            | `direct`, 8000 ms                                   | `jev-call:<id>`            |
| `decisions.triage`                                                                               | Needs You decision triage                                                                       | `direct`, 8000 ms                                   | `jev-call:<id>`            |
| `workflow.rank`, `workflow.screen`, `workflow.route`, `workflow.verify`, `workflow.audit.shadow` | workflow ballots, Find screens and `find-best`, one-answer route, live verify, audit judgements | `direct`, 8000 ms                                   | `jev-call:<id>`            |
| the capability, e.g. `routine.structured`, `advertising.routine`, `orchestration.*`              | routine, advertising-routine and orchestration-shadow decisions                                 | `service`, configured `timeoutMs` (at most 5000 ms) | `jev-call:<id>`            |

Transport and deadline identify the cohort, and cohorts are never pooled. `provider_status` is `not_called` whenever no provider request was sent (`calls: 0`). That covers `--jev off` dry runs, the host switch, environment kill switches, missing credentials and declared-evidence UNKNOWN. A rubric record keeps its own `provider_status`, but its row still says `not_called` when the evaluation was refused before sending. `status` is the record's own status: `verdict | unknown | voided` for rubric evaluations and `success | unavailable` for requests. For in-app callers, `status` is `null`. Only rubric rows carry `kind`. Each retry is its own row. A row is appended when its call finishes and carries the time the call started. When a caller's deadline aborts a call, the row's `reason` is `timeout`; the caller still receives the provider's own error. If a crash leaves a partial last line, the next row starts on a new line. `list` counts the partial line as malformed and `export` skips it.

A ledger write failure never fails or delays a JEV call. In-app rows are queued without waiting. Rubric evaluations and requests wait at most one second for their row, then report `storage.ledger: saved | failed | pending` next to the existing record storage. `omni jev records list` reports `ledger.write_failures`, the number of failed writes since the runtime started.

```sh
omni jev records list --since 2026-10-03 --caller jev.rubrics.evaluate --limit 20 --json
omni jev records export --since 2026-10-02 --json > jev-rows.ndjson
omni jev outcome jev-rubric:<request_id> --file outcome.json --json
# On an SSH/WSL execution host, forward the contents rather than a host-local path:
cat outcome.json | omni jev outcome jev-request:<request_id> --input-stdin --json
```

`list` returns summaries, newest first, with how many outcome rows each record has. The default limit is 50 and the maximum is 1000. `export` prints NDJSON: every `jev-call/1` row, oldest file first, followed by every `jev-outcome/1` row. It fetches the rows one bounded page at a time and keeps working when the file rotates mid-export. `--since` narrows the call rows only. Outcome rows are always exported in full, because a label's `recorded_at` is set by its labeler and can be earlier than the last export. Because a call's row is appended after its start time, an incremental export should overlap its `--since` window. Deduplicate call rows on `record_key`, and outcome rows on `record_key`, `question_id`, `labeler` and `recorded_at`. Export errors go to stderr with exit code 1, so stdout only ever holds rows.

`outcome.json`:

```json
{
  "question_id": "quality",
  "label": "approve",
  "evidence_level": "verification",
  "source": "human",
  "labeler": "sha256:18717f7f1f60f92207bd02972c16aec92f52b31c2a8442444df988d8e8503c5e",
  "blind": true,
  "recorded_at": "2026-10-03T13:00:00Z",
  "correction_minutes": null,
  "note": null
}
```

`question_id` is optional; when it is `null`, the label applies to the whole decision. `label` is a short string, a number or a boolean. `evidence_level` is `ground_truth`, `verification` or `cross_check`. `source` is `human`, `verified_outcome` or `model_reference`; `model_reference` rows are reported separately and never enter quality totals. `recorded_at` is ISO 8601 UTC, defaults to now, and cannot be in the future. `labeler` is `session:<session or agent id>` or `sha256:<lowercase hex SHA-256 of the person's lowercased email>`, for example `echo "sha256:$(printf %s "$EMAIL" | tr '[:upper:]' '[:lower:]' | shasum -a 256 | cut -d' ' -f1)"`; a raw email address is refused, because the ledger loader rejects any row that contains one. Labels and notes are single short lines and cannot contain email addresses or phone numbers. The record must exist on the selected runtime: as a ledger row, or as a rubric or request record saved before the ledger existed. Rows are append-only, so a correction is a new row. A row with the same `record_key`, `question_id`, `labeler` and `recorded_at` as an existing one is refused as a duplicate.

A label comes from a person or from a verified check that names its source. It never comes from the agent that made the prediction. All three commands negotiate `jev.records.v1`, and an older runtime is told to update. Forwarded SSH/WSL shells must pipe the outcome with `--input-stdin`.

Scripts outside the app, such as `jev-decide`, the dispatch router and the TypeSafe evaluation scripts, keep their own logs. The jev-lab loader maps those logs into the same row shape.

## Switch semantics

- The host master setting is persisted atomically as `jev-control.json` in the runtime's user-data directory. Missing configuration preserves existing behavior; malformed configuration fails off.
- Off blocks new TypeSafe provider calls in this app, attempts to abort in-flight calls and discards answers after a switch change. It cannot recall a request already received by the provider. Historical records remain available.
- On permits calls while preserving each feature's existing gates, authorization and budgets. Environment kill switches still win. This switch does not change LLM escalation or control external Python scripts.
- Per-request `off` makes no provider call. `auto`, `on` and `request` respect the host master; `request` is one-off and never edits it. The direct request recipes have no LLM fallback.
- Probability is not verified accuracy. Missing evidence and intermediate confidence remain unknown/reviewable. Typed risk, impact and effort ratings require anchored criteria; they are not exact time or money estimates.

## Evidence in existing workflow verification

The engineering verifier now requires the actual cited code line and its complete bounded numbered window. Missing/unreadable code, invalid locations, oversized scope/reports or windows that would need clipping remain unverified and do not reach JEV. Reviewer claims are untrusted state, separate from evaluator instructions. A file digest binds the reading to its source and a second read rejects source changes during inference. Active cached calls require matching evidence. Recovery-only replay uses the original request digest to reconstruct historical records, including legacy records; it does not assert that today's source was verified.

## Reusable cross-company framework

The companion [jev-lab framework](https://github.com/omnirogue/jev-lab/blob/jev-evidence-protocol-0927/docs/framework.md) supplies tenant profiles, versioned workflow packs, source-bound evidence packets, deterministic rules, optional retrieval, native JEV, conditional or named-required LLM decision review, and separately configured task execution. The initial examples cover research/preparation, support drafts and engineering. Workflow routing is advisory; external action authorization remains with the caller.

The [improvement lab](https://github.com/omnirogue/jev-lab/blob/jev-evidence-protocol-0927/docs/improvement-lab.md) freezes baseline/candidate methods, compares the same observed cases, captures independent outcome receipts, supports blind A/B and B/A reviews, and exports development-only JSON/Markdown for an LLM to propose a versioned rubric or method. Holdout data is excluded from candidate-generation packets. Promotion records never change production switches automatically.

The portable framework's `jev-decision-record/1` is the fully bound lab adapter. Omni request records can be imported as raw inference observations, but they lack frozen experiment and independent outcome metadata and cannot establish an improvement. Existing company workflows still need explicit adapters and independent outcome collection before migration. The Python configuration records Omni DecisionContract references; it does not independently certify the TypeScript registry or calibration.

Company research and current usage: [Slite inventory](https://example.slite.com/app/docs/LhcbH71x1Lzfc1), [evidence protocol](https://example.slite.com/app/docs/UzXhxKYczjHY-6), [unified architecture](https://example.slite.com/app/docs/j5r4OVQVnpClck).
