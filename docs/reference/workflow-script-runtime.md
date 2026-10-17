# Workflow scripts: plan shape, review rules and the script runtime

Added 2026-09-16 for Sal's ask: run parallel, sequential and hybrid multi-model plans, see
the shape before Go and the progress after, keep it reliable, add no competing system.

## What already runs plans

Plans are session chains (`src/shared/session-chain-types.ts`), compiled from the Next
draft (`next-step-compile.ts`, `next-outcome-compile.ts`): fan-outs are steps sharing a
`group`, rounds repeat a step, review rounds carry a `review` assignment and their
reviewers launch together (#291). The team model
(`src/renderer/src/lib/session-team-summary.ts`) merges the chain, the console preview
graph and the live agent-hook rows into seats with a state. Nothing here replaces that.

## The plan shape (preview and progress)

`src/renderer/src/lib/session-team-phases.ts` folds team seats into rows: one row per
fan-out (seats that launch together), one per review round, one per repeated action
with a round counter, one per single seat. `SessionTeamPhaseRows` draws the rows with
the shared agent-state glyph per seat.

- Before Go: `SessionTeamPlanPreview` compiles the draft with placeholder ids
  (`previewSessionChain`) and draws it; every seat is `planned`. Mounted in the Next
  panel (recipients and after-steps) and the outcome editor.
- After Go: `SessionTeamPlanStrip` draws the same rows from the live chain in the
  conversation work header, collapsible, with `done/total`; the session hover card shows
  them densely, so the Terminal view keeps parity through the row.

## Review rules (`src/shared/session-chain-policy.ts`)

Checked on the compiled chain and refused before anything launches (Next panel send and
outcome Save both call `nextStepDraftPolicyProblems`):

| Rule | Level | Source |
| --- | --- | --- |
| Gemini never issues a review verdict or judgement | block | Sal, 2026-08-09 |
| A reviewer is never the exact model that produced the work | block | estate review discipline |
| A judge over several candidates is from a family none of them belong to | block | hub `production_best_of_selection.py` |
| A reviewer from the producer's own family | warn | cross-lineage preferred |

Lineages come from `src/shared/model-lineage.ts`; an agent the table does not know is
never counted as independent. The producer of a review step is what the step reads
(`sessionChainPredecessors`), else the session the plan runs after.

## Best of N (`next-step-templates.ts`)

Candidates from every available family but one work alone on the same request; the
remaining family judges every candidate refute-first and ranks them; a final step picks
the winner and records the ranking beside it. With Codex, Claude and Grok on a host this
is two candidates and a neutral judge, which is what the judge rule allows.

## The script runtime (`src/main/runtime/workflow-script/`)

The Workflow tool's authoring contract, run inside OmniConsole: a script is plain
JavaScript with `export const meta = {name, description, phases}` and a body that awaits
`agent(prompt, {label, phase, schema, model, effort, isolation})`, `parallel(thunks)`
(a barrier; a throwing thunk becomes `null`), `pipeline(items, ...stages)` (no barrier),
`phase(title)`, `log(message)`, with `args` and `budget {total, spent(), remaining()}` in
scope. The script decides the shape; the runtime decides nothing.

Reliability rules baked in:

- A `schema` is validated at the runtime boundary (`src/shared/json-schema-validate.ts`);
  an answer that misses it is asked for again with the defects named, three times, then
  the call returns `null` and the seat reads `failed` with the reason.
- Every call is journaled by content key (`v1:<sha256 of prompt+options>:<occurrence>`);
  a re-run answers unchanged calls from the journal and runs only from the first changed
  call. Only successful answers are journaled (`workflow-script-journal.ts`, append-only
  JSONL).
- `Date.now()`, `new Date()` and `Math.random()` throw inside a script. The realm is NOT
  a security boundary: host functions passed in, like `log`, expose the host `Function`
  constructor through `.constructor`; `log.constructor('return process')()` reaches the
  host `process` (`workflow-script-sandbox.ts`).
- Agents running at once are capped at `min(16, cores − 2)`; a slot is taken before the
  work is awaited. Agent count is capped at 1000, items per call at 4096, and a token
  budget stops calls with a named error the script can handle.
- Dry run (`workflowScript.dryRun`) executes the script against a synthetic world whose
  array answers carry `richness` elements, so data-driven fan-out is visible before any
  agent starts. Why: the realm escape leaves `workflowScript.dryRun` unregistered from
  the RPC method list until a real execution boundary exists: a child process or worker
  realm receiving no host functions. `workflowScript.readMeta` remains registered and
  safe: it evaluates only the `meta` object literal in an empty realm with no host
  functions passed in at all.

### Not wired yet: the live executor

`runWorkflowScript` takes an `execute(call)` adapter and ships with the synthetic one
only. A live adapter must launch a session through the existing outcome host or chain
runner and return the final answer; it needs real-agent tests on a host with accounts,
so it is a follow-up, not a claim. Until then a script is previewed here and run by the
Workflow tool in Claude Code.

Related: `docs/reference/console-task-continuation.md`, `conversation-fleet-dispatch.md`.
