# Local and Hosted Evolve Super Intelligence

Evolve improves an artifact against a defined evaluation task: generate
candidates, test them, compare survivors, and review whether a winner deserves
promotion. The baseline can be a prompt, skill, or another artifact supported by
the evaluator. A larger ensemble increases the search budget; it does not
guarantee a better result.

**Availability, 2026-10-16:** this source snapshot contains desktop contracts for
all three execution tiers. The cross-run leaderboard and MCP batch/receipt
extensions are integration-stage features. A visible control, a sample result,
or an advertised schema is not evidence that a hosted run actually executed.
Use the service's current catalog and durable run evidence to confirm support.

## Select an execution tier

| Tier | Execution and billing | Comparison strategy |
| --- | --- | --- |
| **Local** (`local`) | Your configured evaluator and authenticated CLI environment on the selected execution computer. Provider subscriptions or BYOK may still incur cost. | Evaluation and judges come from the task spec. Selecting Local does not automatically enable a cloud ensemble. |
| **Hosted Pro** (`hosted_pro`) | Hosted service with an OmniRogue account and a server quote. | The desktop describes two frontier families and blind audit verification. Its estimate does not include the Super Intelligence knockout tournament. |
| **Hosted Super Intelligence** (`hosted_super_intelligence`) | Hosted service with a larger quoted budget. | The desktop describes three to four frontier families, a knockout tournament, and blind cross-family audit. Actual families and availability come from the accepted run. |

Choose Local for a configured local evaluation workflow, Hosted Pro for a
smaller hosted comparison, or Super Intelligence for a broader search. Running
locally does not necessarily keep prompts offline: an authenticated provider CLI
may still call its provider.

## Prepare a task that can be evaluated

Define these before starting:

- **Baseline:** the exact artifact to beat, identified by a digest or version.
- **Inputs and rubric:** representative examples and explicit success criteria.
- **Hard checks:** required structure, allowed behavior, length or format bounds,
  and other deterministic constraints.
- **Data splits:** visible fitting/calibration examples, held-out comparisons,
  and a final blind audit. Keep audit answers out of candidate-generation prompts.
- **Budget and stopping rules:** iterations or generations, candidate count,
  spending cap, and patience where the selected interface supports it.
- **Promotion destination:** what would change, who can approve it, and how to
  restore the previous version.

An attractive draft without a reproducible evaluation is insufficient evidence
for promotion. Changing the task, rubric, or held-out data may invalidate a
comparison with an older run.

## Start and follow a run

1. Open **Workflow → Evolve** in OmniConsole.
2. Select the target/spec and execution mode. For Local, ensure the evaluator is
   installed and authenticated on the selected execution computer. For hosted
   work, first [connect OmniRogue](OMNIROGUE-CONNECTOR-GUIDE.md).
3. Set the run size and budget. A desktop estimate is planning information; use
   the server quote and accepted reservation for admission and spend tracking.
4. Optionally seed from an earlier run or reuse a supported rubric digest. Keep
   the source run ID so the lineage can be inspected.
5. Start once and keep the returned run ID. Inspect progress, candidate counts,
   budget, winner evidence, and promotion state in that run's view.
6. When computation finishes, inspect the winner and blind audit before taking
   the promotion action.

The public CLI entry is `omni workflow run evolve`; use its installed `--help`
for the fields supported by your build. `omni workflow status <run-id>` reads an
existing desktop workflow record. MCP uses `si_evolve` when advertised; its
snake_case fields and generation limits differ from the desktop RPC contract.
See the [MCP reference](UNIFIED-MCP-REFERENCE.md#super-intelligence-tools).

The desktop client in this snapshot targets `https://app.omnisi.ai/api/evolve`:

| Route | Purpose |
| --- | --- |
| `POST /quote` | Quote hosted tier and iteration settings. |
| `POST /runs` | Submit a hosted run. |
| `GET /runs/{cloudRunId}` | Read its state and evidence. |
| `POST /runs/{cloudRunId}/promote` | Request promotion of the selected candidate. |
| `POST /runs/{cloudRunId}/rollback` | Request restoration through the service's rollback contract. |

These are desktop client routes, not MCP tool names. Do not interchange desktop
`evo_…` identifiers, cloud run IDs, candidate IDs, and media generation IDs.

## How a knockout tournament works

The Super Intelligence evaluation pipeline can generate candidates from multiple
model families. Each candidate first passes deterministic checks and a JEV
screen. The surviving candidates enter a single-elimination comparison bracket.
Each round advances the preferred candidate until one remains.

Comparisons use the same task and evaluation inputs, with blind presentation
where supported. Cross-family judging reduces dependence on the generator's own
family; it does not eliminate bias. Inspect the recorded judge assignments and
comparison evidence, including ties, byes, unavailable judges, and any fallback
to prefilter scores. Do not describe a fallback score comparison as an
independent model audit.

Winning the bracket identifies the strongest survivor in that run. The candidate
still needs to beat the baseline or incumbent on held-out and audit checks.
Invalid or unavailable evidence should produce a hold, rather than an invented
win. More rounds and more judges consume budget even when no candidate improves.

## Bradley–Terry / Elo cross-run leaderboards

The integration-stage leaderboard pools recorded pairwise outcomes for a
compatible **target spec digest**. It identifies an artifact by its program
SHA-256, so the same artifact retains its history when used in a later run.
Generator-model standings are derived separately from comparisons between
programs attributed to different models.

Bradley–Terry estimates a positive strength for each contestant. For strengths
`sA` and `sB`, the modeled chance of A winning is:

```text
P(A beats B) = sA / (sA + sB)
```

The implementation expresses fitted strengths on an Elo scale with a field mean
of 1500. A 400-point difference corresponds to ten-to-one modeled winning odds;
it is not a percentage of rubric requirements satisfied. Ties contribute half a
win to each side. A regularizing prior keeps sparse or unbeaten records finite.

Read a rating alongside its games, wins/losses/ties, 95% interval, contributing
runs, tier breakdown, and fit convergence. A small number of wins can have a wide
interval. Ratings from different task digests are not comparable, and a rating
is not a universal measure of model quality.

The current module defaults to pooling Local and Hosted Super Intelligence
outcomes. Hosted Pro can be included through its tier filter. Candidate
eligibility defaults to at least three real games. Warm-start selection uses the
highest lower 95% bound among eligible candidates, with the source run and
candidate retained for lineage. A warm-start suggestion is not a promotion.

**Integration limit:** the leaderboard module needs service wiring and persisted
outcome ingestion before a live cross-run leaderboard exists. Do not assume a
public leaderboard route or automatic warm-start behavior merely because the
algorithm is present. No universal leaderboard MCP tool is specified here.

## The JEV promotion gate

JEV provides structured judgments against the task's criteria. Its fitting-stage
screen can save expensive judge calls for candidates unlikely to improve on the
baseline. Screening and final promotion serve different purposes: a candidate
that passes the screen still needs final evidence.

Promotion review should bind the exact candidate digest and baseline to:

1. Passing hard constraints and sufficient valid evaluation coverage.
2. Held-out improvement under the task's configured thresholds and intervals.
3. The blind audit and the actual cross-family judge evidence.
4. The original scope, budget record, and intended promotion destination.
5. Any required human decision for that exact change.

Thresholds belong to the task's versioned spec; there is no universal JEV score
that authorizes every promotion. Neither an Elo rank nor an AI recommendation
grants permission to publish, deploy, spend more, or change a customer's account.

The desktop promotion summary distinguishes **promoted**, **held**, and
**rolled_back**. Record the candidate, score delta, audit summary, and time when
provided. A candidate marked eligible has not necessarily been promoted. A
promotion response is not proof of a production deployment: verify the actual
destination if the approved action requires one.

## Costs, cancellation, and recovery

- Track **estimated**, **reserved**, **settled**, and **released** credits
  separately. Reserved funds are not final spend. When available,
  `credits_receipt` summarizes recorded spend and cache savings by session/run.
- Preserve run IDs after timeouts and refresh their state. Do not launch a new
  paid run merely because a response was lost.
- Lost contact means **unverifiable**. It does not prove that a worker exited or
  that a reservation was released.
- Use Stop only where the service/build offers it; confirm the resulting run
  state. The desktop route allowlist above does not define a hosted cancel API.
  A UI stop request alone does not prove remote provider cancellation.
- A 401 from the hosted service calls for checking that service's authorization;
  the desktop preserves the existing OmniRogue link.
- Roll back through the supported action and read back the resulting artifact
  and promotion record. Do not erase audit history.

Before sharing a result, retain the task/spec digest, baseline and winner
digests, run ID, judge evidence, held-out results, receipt, and promotion decision.
Keep hidden evaluation inputs and private prompts out of public reports.

## Source anchors

The desktop contracts are
[`evolve-workflow.ts`](../../src/shared/evolve-workflow.ts),
[`evolve-workflow-draft.ts`](../../src/shared/evolve-workflow-draft.ts),
[`hosted-evolve-client.ts`](../../src/main/runtime/evolve/hosted-evolve-client.ts),
and [`EvolveExecutionModeSection.tsx`](../../src/renderer/src/components/evolve/EvolveExecutionModeSection.tsx).
The leaderboard section describes the contemporaneous service module contract;
it is explicitly provisional until integrated and deployed.
