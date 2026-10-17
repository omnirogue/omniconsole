# Reusable audit program

The audit library reads a time-ordered corpus, clusters evidence, samples agreement, searches for
novel findings, verifies cited sources, and produces a reviewed plan. It runs on the existing
`WorkflowProgramContext` and `WorkflowExecutionService`. Open **＋ → Workflow → Audit**, enter
the audit question and a prepared corpus filename, choose the file format and models, then
select **Run Audit**. Progress, pause/resume, per-call records and the reviewed report use the
existing workflow conversation. The same primitives are available to internal developer callers.

The [gap analysis](AUDIT-PIPELINE-GAP-2026-10-02.md) explains the design and research limits.
Use the [report template](AUDIT-REPORT-TEMPLATE.md) when presenting a run to a person.
The [comparison guide](AUDIT-QUALITY.md) provides a runnable direct-reader, reader/merge and
full-audit benchmark with separate independent assessments.

The desktop form runs on the computer holding the file. It requires the host's advertised Audit
support; an older host cannot silently substitute Discover. Admission captures the corpus,
resolves the chosen accounts and models, and calculates the complete call budget. Defaults are
up to four cluster groups, two agreement samples, two novelty lenses, twelve themes, three
planner calls and two judge calls. One eligible model can fill multiple roles through separate
calls. The form does not change the default for other workflows.

Only the selected corpus is supplied to agents; the host performs source checks. Prepare the
corpus in a project/data folder: existing context-path policy refuses credential and application
data locations. The JSONL adapter is not a raw account-profile scanner. There is no public
`--template audit` CLI flag, compiler support, or fleet corpus-transfer path in this version.

## Prepare the corpus

Keep the corpus on the computer that owns execution. Pass an explicit absolute filename to
`captureAuditCorpus` from `src/main/runtime/workflow-script/audit/audit-snapshot.ts`:

```ts
const captured = captureAuditCorpus(sourceFile, 'sources-jsonl', 230_000)
```

`sourceFile` must be a regular file no larger than 32 MiB. The function resolves its real path,
reads it, validates sources, and builds the frozen corpus manifest and chunk text. The third
argument is the maximum UTF-8 bytes in a complete chunk, including headers and data prefixes.
Use the returned corpus rather than constructing a manifest by hand.

The `sources-jsonl` format has one object per line:

```json
{"id":"meeting-001","timestamp":"2026-10-02T13:00:00Z","text":"A participant asked for reusable setup instructions."}
{"id":"meeting-002","timestamp":"2026-10-02T14:00:00-04:00","text":"The same setup work was repeated."}
```

Each ID is unique, starts with an ASCII letter or digit, and contains only letters, digits,
periods, colons, dashes and underscores, up to 200 characters. Timestamps require an explicit
timezone and normalize to UTC. Sources sort by absolute time, with source ID breaking ties;
input-file order does not affect chunk membership. Each complete source belongs to one chunk.

For extractor output, use `digests-jsonl` with one digest per line:

```json
{"id":"session-001","first_ts":"2026-10-02T13:00:00Z","user_msgs":[{"ts":"2026-10-02T13:00:00Z","auto":false,"text":"Please reuse the setup instructions."}],"assistant":[{"ts":"2026-10-02T13:01:00Z","text":"The recipe is saved."}]}
```

`user_msgs` and `assistant` are arrays of text messages. Message timestamps may be absent or
null; those messages are explicitly marked unknown and use the source start time for ordering.
The extractor's `auto` label is preserved, including unknown when absent; `auto: false` does not
prove human authorship. Existing clipping markers remain, and this adapter adds no truncation.
Other extractor fields are not used. Raw Claude/Codex event logs, inventory, deduplication across
account homes, and session classification remain the caller's preprocessing responsibility.

An oversized indivisible source is refused. Increase the explicit budget within the downstream
prompt limit, or split it into separately identified source records before admission. If splitting
one original document, remember that the audit then counts those IDs as separate sources; choose
source granularity deliberately when interpreting corroboration. No reader silently receives
only a prefix. Sources and report claims remain untrusted data.

## Configure the frozen program

Resolve seats through the host's existing account/catalog admission before building the snapshot.
The IDs below are example IDs in that resolved `seats` array, not provider names or credentials:

```ts
const audit: AuditSnapshot = {
  version: 1,
  ...captured,
  readerSeatId: 'reader',
  reviewerSeatId: 'reviewer',
  plannerSeatIds: ['planner-a', 'planner-b', 'planner-c'],
  judgeSeatIds: ['judge-a', 'judge-b'],
  synthesizerSeatId: 'writer',
  clusterGroups: 4,
  agreementSamples: 2,
  noveltyLenses: ['Repeated work', 'Knowledge reuse', 'Unfinished work'],
  maxThemes: 16,
  existingFindings: [],
  reference: {
    facts: 'Independently computed corpus totals and known exclusions.',
    requests: 'The requester’s requirements extracted independently of the readers.',
    status: 'Current implementation or adoption evidence with dates and references.'
  }
}
validateAuditSnapshot(audit, seats)
```

`AuditSnapshot`, `captureAuditCorpus`, `auditCallLimit` and `validateAuditSnapshot` are exported
from `audit-snapshot.ts`. References are optional, at most 20,000 characters per field. Supply
actual independently collected evidence, not the example sentences above. Absent facts/requests
are reported as a gap; absent status evidence stays unknown. The program does not automatically
query Slite, Jira, GitHub, or another provider.

Exactly three planner calls take different angles; exactly two judge calls score anonymous plans
independently. Each call is a fresh agent; reusing a seat does not reuse its conversation. Prefer
different model families where available and disclose actual seats when interpreting agreement.
Reviewer/judge/synthesizer seats must be permitted to issue verdicts under existing lineage rules.

Bounds: 1–64 chunks, 1–8 cluster groups, 0–one agreement sample per chunk, at most eight novelty
lenses of 200 characters each, 1–24 final themes, and at most 200 planned model calls.
`auditCallLimit` includes the optional revision and post-novelty merge. Zero agreement samples or
an empty novelty-lens list explicitly skips that measurement and leaves a gap in the method record.
The main program runs one novelty round, not a saturation loop.

Every item in `existingFindings` uses the versioned finding contract from
`src/shared/workflow-audit-contracts.ts`; its evidence must refer to this admitted corpus.
Reader/cluster/verify/novelty/agreement schemas and validators reject malformed outputs and
unknown references. Distinct evidence counts and agreement totals are computed in code.

## Run through the existing service

Build a `WorkflowProgramSnapshot` using the captured audit and already resolved seats:

```ts
const snapshot: WorkflowProgramSnapshot = {
  version: 1,
  task: { prompt: requestedAnalysis, evidence: corpusDescription },
  seats,
  synthesizerId: audit.synthesizerSeatId,
  audit
}
const callLimit = auditCallLimit(audit)
const executionId = service.start({
  conversationId,
  requestId,
  snapshot,
  preset: 'discover',
  fence,
  attemptLimit: 3,
  callLimit,
  budgetLimit: callLimit * 3
})
const outcome = await service.wait(executionId)
```

Here `service` is the execution host's configured `WorkflowExecutionService`; conversation,
request and fence identities come from its normal lifecycle. The budget example assumes the
probe's reservation of one unit per attempt; use the host's actual reservation policy. The
`discover` value is the existing storage envelope, not a request to run the ordinary Discover
template. The frozen `audit.version` selects the bundled program. Do not combine it with a graph
snapshot or a working-agent capability. Public `localWorkflow.start` accepts a bounded
`draft.audit` source selection on a Discover storage anchor, never a caller-supplied snapshot.
It requires `runsOn: 'local'`, `access: 'frozen'`, a proven local workspace and resolved seats.

`runAuditProgram(context, audit, task, ports)` is the lower-level composition seam. Give it the
existing durable context and `auditPortsForExecution(...)`, never a replacement scheduler.
The service dispatches it through `runWorkflowPreset`. The provider/account resolver, attempt
admission, cancellation, process receipts and result validation remain the existing service's
responsibility. Direct function calls alone are not proof of durable execution.

Source verification re-reads registered IDs from `sourceFile` and checks ID, timestamp, UTF-8
size, content digest and quote presence. It cannot follow a path supplied by a model. Exact quote
presence does not establish the claim's meaning, so separate evidence and impact reviews still
run. An evidence/impact refutation drops a theme; unresolved evidence stays unverified; status
annotates it. Required stage failures stop the program visibly.

Accepted model outputs reuse the existing call cache keyed by the full prompt, schema,
dependencies and frozen seat/route. Source checks and shadow judgments are recorded beside the
execution. Completed replay reconstructs historical results without reopening a removed corpus
or launching new agents; it is not a fresh audit of a changed corpus. Start a new captured run
when you want to judge new source content.
Present corrupt cache records fail visibly; only an absent record permits new work. Corpus
reads use a bounded open file descriptor, so concurrent growth cannot bypass the size ceiling.

On SSH, `sourceFile` denotes a path on the execution host, never a client path. This
version does not copy the corpus between hosts or admit a fleet audit. Run the app/API on the host
that owns the file, or implement reviewed corpus transport/admission through the existing fleet
path before exposing remote starts. Ordinary folder workspaces work; Git is not required.

## JEV observations

Audit Score/Noul questions are versioned **shadow observations**. They do not sort, merge,
discard, approve, or dispatch work, and the generative judgments remain authoritative. Score is
ordinal; Noul is a proposition probability; neither establishes quote truth or grants permission.
This version has no calibrated audit threshold.

The program records theme-ranking Scores, an adjacent-theme duplicate sample, and all finding
pairs within each sampled agreement chunk. Agreement questions are batched in groups of at most
32 judgments plus their availability questions. This duplicate sample is not an exhaustive
pairwise deduplication decision; clustering remains generative and preserves cited evidence.

The normal service path supplies no corpus-specific redactor and therefore makes no JEV
inference. A trusted host integrating the lower-level ports can supply
`auditPortsForExecution(audit, executionId, cacheOnly, { judgements: { redact, ...options } })`.
The redactor must remove corpus-specific identifiers before egress; the generic secret redactor
alone is insufficient. Only verified source IDs are eligible. Missing redaction/evidence,
disabled inference, unavailable/invalid responses and provider bounds retain the generative
path with a recorded reason. Never supply credentials in a snapshot or source file.

## Run the synthetic integration probe

From the repository root, with dependencies installed:

```sh
npx tsx config/scripts/workflows/probe-audit-pipeline.ts /absolute/path/to/new-audit-evidence
```

The destination must not exist. The probe uses the existing service, checkpoint database and
native-process fixture, with a small synthetic JSONL corpus. It exercises grouped reading,
deduplication with distinct-source counting, agreement, empty novelty, fabricated-quote rejection,
planning, judging, critique/revision and replay after the original corpus is removed.
Inspect its saved report and launch ledger; do not infer success from dispatch alone.

This probe makes no paid agent or JEV calls and establishes no model-quality, cost-saving,
live-fleet, UI, or production-deployment result. Actual validation commands and outcomes are
recorded in [IMPLEMENTATION-STATUS.md](IMPLEMENTATION-STATUS.md). Required GitHub checks remain
the merge authority.
