# Cookbook: Evolve Tournaments

This cookbook shows how to run a **Local Evolve** run, challenge its winner with
a **Hosted Super Intelligence** pairwise tournament, use **JEV** to drop weak
candidates before the expensive comparisons, and take the **one-click
promotion** decision once a winner exists.

[Local and Hosted Evolve Super Intelligence](HOSTED-EVOLVE-SUPER-INTELLIGENCE.md)
explains the concepts. This cookbook works through the same features one recipe
at a time and points to the code that implements each step.

> **Availability, 2026-10-16.** This source snapshot includes the local/fleet
> Evolve runner, the hosted client (quote, submit, poll, event stream, promote,
> and rollback routes), the bracket and Elo calculations, and the
> promotion-decision card. Some pieces are still at the integration stage: the
> leaderboard drawer is not mounted in a run view, the desktop never calls the
> hosted `promote` route, and the JEV screen inside a hosted tournament runs in
> the hosted service, not in this repository.
> [What is wired today](#what-is-wired-today) lists each piece. A visible
> button, a sample payload, or an advertised schema does not prove that a
> hosted run executed or that a candidate was promoted.

## Contents

1. [Vocabulary](#vocabulary)
2. [The tournament at a glance](#the-tournament-at-a-glance)
3. [Before you start](#before-you-start)
4. [Recipe 1: Produce a local incumbent](#recipe-1-produce-a-local-incumbent)
5. [Recipe 2: Challenge it with Hosted Super Intelligence](#recipe-2-challenge-it-with-hosted-super-intelligence)
6. [Recipe 3: Follow the tournament live](#recipe-3-follow-the-tournament-live)
7. [Recipe 4: Read the pairwise bracket and family Elo](#recipe-4-read-the-pairwise-bracket-and-family-elo)
8. [Recipe 5: Pre-filter candidates with JEV](#recipe-5-pre-filter-candidates-with-jev)
9. [Recipe 6: One-click promotion](#recipe-6-one-click-promotion)
10. [Recipe 7: Compound on the winner](#recipe-7-compound-on-the-winner)
11. [Budget guardrails](#budget-guardrails)
12. [Troubleshooting](#troubleshooting)
13. [What is wired today](#what-is-wired-today)
14. [Source anchors](#source-anchors)

## Vocabulary

| Term | Meaning in this cookbook |
| --- | --- |
| **Target** | What Evolve improves. Built-in targets are `email-smoke`, `email`, and `ads`. `spec` means a custom spec path. |
| **Spec** | A YAML (or JSON) file in a jev-lab checkout that defines the baseline, evaluator, rubric, data splits, and budget group. Its frozen digest is `spec_sha`. |
| **Candidate** | One program variant that Evolve generated. Its content digest is the **program SHA**. |
| **Incumbent** | The version to beat. In a hosted challenge this is your best local winner. |
| **Hard checks** | Deterministic pass/fail constraints such as structure, format, length, and allowed behavior. |
| **JEV screen** | A cheap rubric-based score (0–4 per criterion) that drops weak candidates before pairwise judging. |
| **Pairwise comparison** | Two candidates judged on the same inputs, blind where supported. The higher score advances. |
| **Knockout bracket** | Single-elimination rounds: round of 4, final, then an **incumbent challenge**. |
| **Promotion record** | A ledger row with a `decision`, `hard_pass`, `intervals_pass`, and `availability` for one candidate. |
| **Decision** | The human choice to promote the winner or keep the incumbent. It is published to OmniOS Decisions and mirrored in the run view. |
| **Compounding seed** | A promoted candidate that later runs load with `--seed-from <target>`. |

Keep the four kinds of identifier separate. The desktop run ID is `evo_<uuid>`,
the ledger run ID comes from jev-lab, the hosted ID is `cloudRunId`, and
candidates have their own IDs. Never pass one where another is expected.

## The tournament at a glance

```text
 ┌──────────────── Local Evolve (fleet host or this computer) ────────────────┐
 │ spec ─► submit (freeze spec_sha) ─► detached worker ─► mutations ─► ledger │
 │                                                  best_so_far ─► INCUMBENT  │
 └────────────────────────────────────────────────────────────────────────────┘
                                   │ seed_from_run_id (auto-picked best local run)
                                   ▼
 ┌──────────────── Hosted Super Intelligence (omnisi cloud) ──────────────────┐
 │ 3–4 frontier families generate candidates                                  │
 │   └─► hard checks ─► JEV screen ─► top survivors (seeds 1–4)               │
 │         round of 4:  1 v 4      2 v 3                                      │
 │         final:       winner v winner            ─► CHALLENGER              │
 │         incumbent challenge: INCUMBENT v CHALLENGER (tie keeps incumbent)  │
 │   └─► blind cross-family audit ─► promotion record (hard / intervals)      │
 └────────────────────────────────────────────────────────────────────────────┘
                                   │ run settles `done`
                                   ▼
        Decision card + OmniOS Decision: Promote winning version | Keep incumbent
                                   │ promote
                                   ▼
             Next run: --seed-from <target> compounds on the winner
```

Each stage costs more per candidate than the stage before it. Deterministic
checks are close to free, a JEV screen costs a fraction of a cent per page, a
pairwise model judgment costs more, and a blind cross-family audit costs the
most. The rest of this cookbook follows the same order: discard candidates
early and cheaply, and save the expensive judgments for candidates that can
still win.

## Before you start

| Need | Local Evolve | Hosted Super Intelligence |
| --- | --- | --- |
| jev-lab checkout | On the execution host (default `~/Repos/jev-lab-evolve`, used only by Evolve workers) with its `.venv` and the spec file. | On **this computer**. The hosted submit reads the spec locally and uploads it. |
| Model access | Claude signed in on the host over SSH with a subscription (the drafter is `claude -p`). API-key variables are unset for the readiness check. | A connected OmniRogue account (Settings). See the [connector guide](OMNIROGUE-CONNECTOR-GUIDE.md). |
| Ledger | The host must reach the central ledger. jev-lab reads its connection variables by name; they never enter the run record. | Run by the hosted service. |
| Spec | Any valid spec in the checkout. | At most **256 KiB**, and must parse as a JSON or YAML object. |
| Budget | `--usd-cap` (≤ $1,000, never above the spec's group cap). | A server quote and reservation in credits, plus any `usdCap`. |

Write down the **baseline**, **rubric**, **held-out split**, **blind-audit
split**, and **promotion destination** before you spend anything. If the task
cannot be evaluated reproducibly, a tournament winner is not evidence for
promotion.

## Recipe 1: Produce a local incumbent

A hosted challenge needs something to beat. Start with a local run.

### Desktop

1. Open **Workflow → Evolve**.
2. Under **Execution mode**, choose **Local AI (Your Machine / Fleet
   Subscription)**.
3. Pick a target. `email-smoke` is the default synthetic smoke test; use it
   first to prove the host works.
4. Leave **Run on** set to the fleet (the placement chooser picks a host with
   spare capacity), or name a host, or choose this computer. This computer is
   refused on Windows.
5. Set **Iterations** (1–500), **Patience** (stop after N consecutive
   mutations without a better `best_score`; the spec default is 4), and **USD
   cap**.
6. Select **Start Evolve** and keep the `evo_…` ID.

### CLI

```bash
# Smoke-test a host first.
omni workflow run evolve --target email-smoke --iterations 3 --host <fleet-host> --json

# A real run that compounds on earlier promoted candidates, capped at $5.
omni workflow run evolve --target email --seed-from email-replies --usd-cap 5 \
  --requested-by "<person>" --request "<their words>" --no-follow --json

# A custom spec inside the checkout (relative .yaml path, no "..").
omni workflow run evolve --spec-path jevlab/evolve/my-task/evolve.yaml --iterations 20 --json

# Read it back later.
omni workflow status evo_<uuid>
```

When an agent starts the run, it must pass `--requested-by` and `--request`.
Both values are frozen with the run. An agent can never force a busy host.

### What happens

1. **Admission.** Everything is checked before anything is submitted:
   placement, then one SSH readiness call (Claude login, checkout, `.venv`,
   and spec). A refusal names the host and the reason.
2. **Submit.** jev-lab freezes the spec in the ledger and returns the ledger run
   ID.
3. **Worker.** One detached `nohup` worker runs on the host. Its pid and log are
   in `~/.omni-fleet/evolve-runs/<evo id>/` (mode 700). The worker outlives the
   SSH call and the desktop app.
4. **Follow.** Every 15 s the desktop checks the worker (`kill -0`) and then
   reads `status --json`. Lost contact is `unverifiable`, never a failure. After
   one hour without contact, following pauses until you select **Check again**
   (`evolve.refresh`).

### What to keep from the run

The run view and `omni workflow status` show what you need for the next
recipe. Keep these values:

- `best_so_far.candidate_id`, `best_so_far.program_sha`, and `combined_score`.
  These define the incumbent.
- `spec_sha` and the rubric digests (`rubrics[].rubric_sha`). A comparison
  across runs is fair only when these match.
- `budget.spend_usd` against `run_cap_usd`.
- The exact status command, which you can paste on the host:

```bash
cd ~/Repos/jev-lab-evolve && .venv/bin/python -m jevlab evolve status <ledger-run-id> --json
```

## Recipe 2: Challenge it with Hosted Super Intelligence

### Desktop

1. Open a new **Workflow → Evolve** tab with the same target.
2. Under **Execution mode**, choose **Hosted AI Super Intelligence**.
3. Under **Cloud tier**, choose **Hosted Super Intelligence**. **Hosted Pro**
   uses two families and no knockout tournament.
4. Check **Seed from**. In hosted mode the form fills it in automatically with
   your best local winner (see below), and records the source run as
   `seedFromRunId`.
5. Check the **Estimated Credits** badge, then select **Start Evolve**.

### How the local winner is picked

`findBestLocalWinnerSeed` (`src/shared/evolve-workflow-draft.ts`) considers only
**local or fleet** runs: runs with no `cloudRunId` and not run on `hosted`. Each
run must be `done` or already have a best candidate. Among those runs, it:

1. Prefers runs with the **same target** as the form. If there are none, it
   falls back to all local runs.
2. Ranks them by `summary.best_combined_score`, or by `best_so_far.combined_score`
   when the summary has none.
3. Breaks ties with the most recently updated run.

When you switch to hosted mode, the form:

- Keeps any **Seed from** text you already entered. If the field is empty, it
  fills in the winner's target (or its `evo_` ID for a `spec` target). With no
  local winner, it uses the current target.
- **Always** sets `seedFromRunId` to the winner's `evo_` ID, even when it kept
  your **Seed from** text. With no local winner, `seedFromRunId` is empty.

Changing the target while in hosted mode picks the winner again and overwrites
both fields. Check them right before you start.

> A score is comparable only under the same `spec_sha` and rubric. If your best
> local run used a different spec version, the auto-pick can choose an
> incumbent that the hosted run cannot measure fairly. Check the digests before
> you start.

### The estimate

The badge is a local, deterministic estimate (`estimateHostedEvolveCredits`).
When you are signed in, the desktop asks the server for a quote
(`POST /api/evolve/quote`). If that request fails, it silently uses the local
estimate, so treat the badge as a planning figure. The server's accepted
reservation is the actual amount admitted.

```text
credits = max(25, round((iterations × perIteration + auditOverhead) × targetWeight))
```

| Tier | perIteration | auditOverhead | Families | Knockout | Blind audit |
| --- | --- | --- | --- | --- | --- |
| `hosted_super_intelligence` | 36 | 90 | 4 | yes | yes |
| `hosted_pro` | 14 | 30 | 2 | no | yes |

`targetWeight` is `0.75` for `email-smoke` and `1` otherwise. The default is 10
iterations, capped at 500. Examples:

| Tier | Target | Iterations | Estimate |
| --- | --- | --- | --- |
| Super Intelligence | `email` | 10 | 450 |
| Super Intelligence | `email-smoke` | 10 | 338 |
| Pro | `email` | 10 | 170 |
| Pro | `email-smoke` | 10 | 128 |

### What the desktop sends

`POST https://app.omnisi.ai/api/evolve/runs` with a bearer token from the
OmniRogue account lease. Set `OMNISI_CLOUD_URL` to point at another origin. Only
`https:` is accepted, except for `localhost` or `127.0.0.1`.

```json
{
  "spec": { "...": "the spec file, parsed", "target_summary": "email (jevlab/evolve/email/evolve.yaml)" },
  "generations": 10,
  "execution_tier": "hosted_super_intelligence",
  "seed_from_run_id": "evo_…"
}
```

The service rejects unknown top-level fields, so the target summary is placed
inside `spec.target_summary`. Requests time out after 20 s, redirects are
refused, and response bodies over 1 MiB are rejected.

### From MCP

When the `si_evolve` tool is advertised, it starts, reads, and promotes hosted
runs. Its fields are snake_case, and its limits differ from the desktop RPC: 1–8
generations (default 3) and 1–8 candidates per generation (default 4).

```json
{ "action": "start", "execution_tier": "hosted_super_intelligence",
  "target": "prompt", "generations": 3, "candidates_per_generation": 4 }
```

```json
{ "action": "status", "run_id": "<cloud-run-id>" }
```

The base `si_evolve` handler includes in-memory sample completion records.
These records do not prove that a real ensemble ran. See the
[MCP reference](UNIFIED-MCP-REFERENCE.md#super-intelligence-tools).

### From the CLI

`omni workflow run evolve --help` documents `--runs-on fleet|local` only, and
there is no tier flag. Start hosted runs from the desktop or MCP. Read them back
with `omni workflow status evo_…`.

## Recipe 3: Follow the tournament live

A hosted run is followed in two ways:

- **Event stream:** `GET /api/evolve/runs/{cloudRunId}/events` (Server-Sent
  Events). It feeds the live **progress card**.
- **Polling:** `GET /api/evolve/runs/{cloudRunId}` every 15 s. **Only polling
  decides when the run has ended.**

| Service event | Progress kind | Effect on the card |
| --- | --- | --- |
| `candidate_evaluated` | `evaluated`, or `eliminated` | Increments **evaluated**. A payload `status` of `failed`, `duplicate`, `rejected`, `eliminated`, or `tournament_eliminated` (or `failure_class: tournament_eliminated`) also increments **eliminated**. |
| `frontier_advanced` | `frontier` | Sets **best** to this candidate and score. |
| `canary_promoted` | `promoted` | Adds a "promoted" entry to the recent list. |
| `canary_rolled_back` | `rolled_back` | Adds a "rolled back" entry to the recent list. |
| `budget_exhausted` | `budget` | The run hit its budget. |
| `lease_reclaimed` | `lease` | A worker lease was reclaimed and the work resumed elsewhere. |

Other event types only advance the cursor. The card keeps the 12 most recent
entries and the highest generation seen.

Stream behavior to expect:

- The service sends a keep-alive every 15 s. After 45 s of silence the stream is
  treated as dead, and the card switches to `polling`.
- On reconnect the desktop sends `Last-Event-ID`, so events resume instead of
  replaying.
- A `token_expired` or `resync` frame ends the stream cleanly. A stream that
  answers without `text/event-stream`, or with a frame over 256 KiB, is
  dropped, and polling continues.
- A 401 or 403 reads as *"Hosted Super Intelligence rejected token (401);
  existing OmniRogue session preserved."* The desktop never unlinks your
  account because of a cloud rejection.

**Stopping a hosted run.** **Stop** (`evolve.stop`) only sends SIGTERM to a
local worker. A hosted run has no local worker, so the desktop answers *"This
Evolve run has no running worker to stop."* The desktop has no hosted cancel
route. Use the service's own controls if it offers them, then read the run state
back. If you lose the response after submitting, refresh the existing
`cloudRunId`; do not start a second paid run.

## Recipe 4: Read the pairwise bracket and family Elo

The bracket and rating calculations are in
`src/renderer/src/components/evolve/evolve-leaderboard-helpers.ts`. They are
pure functions, so you can check any published result by hand.

### Bracket rules (`buildKnockoutBracket`)

- The bracket has exactly **four entrants** plus one **incumbent**, all with
  distinct IDs.
- **Round of 4:** seed 1 plays seed 4, and seed 2 plays seed 3.
- **Final:** the two semifinal winners. The final's winner is the
  **challenger**.
- **Incumbent challenge:** the incumbent plays the challenger.
- Each entrant has a separate blind-audit score **for each round it reaches**.
  A round without a score is still being judged, and no winner is decided for
  that match.
- **Ties:** in the round of 4 and the final, the better (lower) seed advances.
  In the incumbent challenge the **incumbent keeps the title on a tie**, so a
  challenger must win outright to be promoted.

### Worked example (illustrative scores)

| Round | Top | Bottom | Advances | Why |
| --- | --- | --- | --- | --- |
| Round of 4 | `c-17` seed 1, 0.82 | `c-31` seed 4, 0.79 | `c-17` | Higher score |
| Round of 4 | `c-22` seed 2, 0.77 | `c-09` seed 3, 0.77 | `c-22` | Tie, better seed |
| Final | `c-17`, 0.84 | `c-22`, 0.86 | `c-22` | Higher score; becomes the challenger |
| Incumbent challenge | local winner, 0.86 | `c-22`, 0.86 | **local winner** | Tie, so the incumbent keeps the title |

With these scores the drawer reads *"Local winner keeps the title."* If `c-22`
had scored 0.88 in the challenge, it would read *"c-22 (GPT-6 Astra) beat the
local baseline."*, and the result would have `incumbentRetained: false`.

A candidate's score can change from round to round because each round is a
separate judgment. Do not carry a round-of-4 score into the final.

### Family Elo (`familyEloStandings`)

The drawer also rates each **generator family** by its pairwise blind-audit
record against the field:

```text
score  = (wins + draws / 2) / games
Elo    = round(1500 + 400 × log10(p / (1 − p))),  p = score clamped to [0.01, 0.99]
95% CI = the Wilson score interval of `score`, each bound mapped through the same curve
```

| Family (illustrative record) | W–L–D | Games | Score | Elo | 95% range |
| --- | --- | --- | --- | --- | --- |
| Claude Opus 5.5 | 7–2–1 | 10 | 0.750 | 1691 | 1460–1922 |
| GPT-6 Astra | 4–5–1 | 10 | 0.450 | 1465 | 1261–1670 |
| Gemini 4 Argon | 1–5–0 | 6 | 0.167 | 1220 | 896–1544 |

How to read it:

- A family with **no games has no rating**. It is not shown as 1500, so nothing
  appears measured that was not.
- Ten games still give a wide range. In the table, the ranges for the first two
  families overlap, so the data do not show that the first family is better.
- A **perfect record is clamped**. A 3–0–0 family rates 2298 with a range of
  1457–2298, which says almost nothing about it.
- A family marked `warmStartChampion` seeded this run. Treat its record as
  partly inherited.
- These per-run family ratings differ from the service's cross-run
  Bradley–Terry leaderboard, which pools outcomes by target spec digest and is
  still provisional. See
  [Bradley–Terry / Elo cross-run leaderboards](HOSTED-EVOLVE-SUPER-INTELLIGENCE.md#bradleyterry--elo-cross-run-leaderboards).

### Semantic diff and behavior deltas

The drawer also compares the incumbent with the winner:

- `buildSemanticDiff` compares lines **after collapsing whitespace**, so
  indentation-only edits count as unchanged. A removed line and an added line
  that share at least 40% of their words (Dice similarity) are paired as one
  **modified** row. Above 4 million comparison cells, the diff falls back to
  pairing lines by position.
- `behavioralDeltas` reports each measured behavior (pass rate, latency,
  refusals, and so on) as `improved`, `regressed`, or `unchanged`, taking
  `higherIsBetter` into account. `formatSignedDelta` always shows a sign
  (`+4.5%`, `-120 ms`, `±0`), so a delta is never mistaken for a level.

Before you promote, read the **regressed** rows, not only the headline score.
For example, a winner that improves pass rate but doubles latency may still be
the wrong choice for your destination.

## Recipe 5: Pre-filter candidates with JEV

### Why pre-filter

The incumbent challenge and blind audit are the most expensive judgments in the
tournament. A Super Intelligence run can generate dozens of candidates across 3–4
families, but only four reach the bracket. A cheap screen that removes clearly
weak or invalid candidates before pairwise judging saves most of the judging
budget.

### Order of filters

Run them in this order and stop at the first failure:

1. **Hard checks (deterministic code).** Schema, required sections, length
   bounds, forbidden content, and duplicates (same program SHA). They are free
   and never wrong about what they check.
2. **JEV availability gate.** Can the judge tell from the evidence provided? If
   the normalized availability is below **0.7**, the answer is
   **unknown**, not low quality. Load more evidence or escalate; do not score
   the candidate.
3. **JEV rubric screen.** Score each surviving candidate 0–4 against the
   task's rubric criteria.
4. **Selection.** Keep the candidates that pass a **calibrated** cutoff, then
   take the top four as seeds 1–4 for the bracket.
5. **Pairwise bracket, then blind audit** (Recipe 4).

A candidate that passes the screen still has to win the bracket, beat the
incumbent, and pass the audit. **Passing the screen is not evidence for
promotion.**

### Where the screen runs

| Path | Who runs the screen | What you see in the desktop |
| --- | --- | --- |
| Hosted Super Intelligence | The hosted evaluation pipeline, before the bracket. | `candidate_evaluated` events with `rejected` or `eliminated` status raise the **eliminated** count (Recipe 3). |
| Local Evolve | jev-lab's evaluator, configured by the spec's rubric stages. | Ledger `candidates.by_status` and `rubrics[]` digests in the run view. |
| Your own workflow | `jevScreen` / `screenWithJev` in this repository, or `omni jev rubrics evaluate`. | The scores, the unscored candidates, and the cost, recorded with the step. |

### Build a screening rubric

A rubric is plain text. **Two or more bulleted lines are scored as separate
criteria**, so you can see which criterion decided the ranking. Without bullets,
five default criteria apply: task fit, evidence, completeness, clarity, and
insight.

```json
{
  "name": "Email reply screen v1",
  "kind": "reply",
  "instructions": "- Answers the customer's actual question in the first two sentences.\n- States only facts present in the supplied order record.\n- Gives one clear next step the customer can take.\n- Stays within the brand voice guide supplied as evidence.\n- Contains no promise of refunds, credits or dates not in the record."
}
```

```bash
omni jev rubrics list --json                      # reuse an existing rubric if one fits
omni jev rubrics save --file screen-rubric.json --json
```

Names are limited to 80 characters and instructions to 6,000. An existing
saved name requires `--replace`, and built-in rubrics cannot be overwritten.
Saving a rubric never changes the criteria frozen in an earlier run. To pin an
exact rubric for an Evolve run, use `--rubric-from <sha256>`.

### Screen one candidate (advisory)

```json
{
  "rubric": "Email reply screen v1",
  "task": "Reply to a customer asking where their order is.",
  "response": "<candidate output on a visible calibration example>",
  "evidence": { "status": "verified", "text": "<order record, redacted>" }
}
```

```bash
omni jev rubrics evaluate --file evaluation.json --json
# Over SSH/WSL, pipe instead:  cat evaluation.json | omni jev rubrics evaluate --input-stdin --json
# Dry run with no provider call:  --jev off
```

If the evidence status is `missing`, `stale`, `conflicting`, or `unverified`,
the call returns **UNKNOWN** without asking the model. Treat that candidate as
*not screened*, not as *failed*. Each result has a record key (for example
`jev-rubric:<request_id>`). Attach the real outcome to it later with
`omni jev outcome` so the cutoff can be calibrated.

### Screen a whole pool in a workflow

Inside a workflow script, a screen step takes a `GraphScreenRequest`:

```json
{
  "task": "Reply to a customer asking where their order is.",
  "rubric": "- Answers the question first.\n- Uses only facts in the record.\n- One clear next step.",
  "candidates": [
    { "id": "c-09", "text": "…" },
    { "id": "c-17", "text": "…" },
    { "id": "c-22", "text": "…" }
  ]
}
```

Behavior to rely on (`graph-jev-screen.ts`, `jev-rank.ts`):

- The pool is screened **once**, and the result is stored under a SHA-256 of
  the request. A replay with the same request reuses the stored result, and a
  changed pool is screened again.
- A **transient** failure on any candidate (rate limit, overload, network, or
  timeout) voids the whole page and is never stored. **Retry** screens the
  whole page again.
- If the only misses are non-transient, the page is kept and the unscored
  candidates are listed as a gap. Do not treat an unscored candidate as a zero.
- The step's markdown lists the top five candidates with scores on the 0–4
  scale and names the model used.

### Choose the cutoff from data, not intuition

These rules come from [`docs/skills/jev/SKILL.md`](../skills/jev/SKILL.md).
Follow that file whenever you set or change a JEV threshold.

- A cutoff applies to **one** question version, decision kind, and direction.
  Choose the lowest cutoff whose **Wilson 95% lower bound** meets your target
  precision **against real outcomes**. The vendor confidence field is never a
  cutoff, and neither is another model's labels.
- A difference smaller than **0.05** is a tie. Do not let the screen order two
  candidates that close together.
- Send candidates in the unsure band to a **different model family** with the
  same question and an explicit `cannot_tell` option. Do not drop them.
- Audit a random sample of confident screen decisions too.
- A changed question or threshold is a **new version**. It replaces the
  incumbent only after it wins on the same held-out cases.

A practical starting point, adjusted per task once you have outcomes:

| Pool size after hard checks | Keep for the bracket |
| --- | --- |
| ≤ 4 | All (pad with byes rather than lowering the cutoff) |
| 5–16 | Top 4 above the calibrated cutoff |
| > 16 | Top 4 above the cutoff, with at most 2 per family so one family cannot fill the bracket |

Of these, only the **top 4** is fixed by the code: `buildKnockoutBracket`
requires exactly four entrants. The family cap and padding policy are
suggestions. Write whichever you choose into the task's versioned spec.

### Pairwise JEV, when you need a full ranking

If you need a full order rather than a screen, `rankHeadToHead`
(`src/main/structured-decisions/jev-rank-pairwise.ts`) judges every pair in
**both orders**, so presentation position cannot decide a comparison. It saves
calls in three ways:

- Identical answers tie at 0.5 without a call.
- A pair that JEV ties in one order is not asked in the other order.
- Pairs that can no longer affect the top two are skipped.

Calls are scheduled with the round-robin circle method, so no answer appears in
two concurrent pairs.

### Anti-patterns

- Using the screen score as the promotion score. The screen and promotion
  serve different purposes.
- Screening with rubric text taken from the **blind-audit** split. Keep audit
  inputs out of everything upstream of the audit.
- Asking JEV to count, add, or compare dates. Compute those in code and pass
  the results in as text.
- Retrying a voided page with a smaller pool to "get it through". The page is
  voided as a whole so that a partial result is never cached.

## Recipe 6: One-click promotion

When a run settles `done`, its run view shows the **Evolve Decision** card. The
card follows a summary-first layout: one summary line, four metrics, the
recommended option marked, and the evidence collapsed.

### Read the card before you click

| Metric | Source | Caveat |
| --- | --- | --- |
| **Challenger vs Baseline** | Winner: `best_so_far.combined_score`, or `summary.best_combined_score`. Baseline: the **first seeded** candidate's `prior_combined_score`, or its `combined_score`. | If the run had no seed, there is no baseline and the delta shows `—`. |
| **Held-out delta** | Challenger minus baseline, to 4 decimals. | Comparable only under the same `spec_sha` and rubric. |
| **Blind cross-family audit** | The first promotion record: `decision · hard pass/fail · intervals pass/fail`. | **If there is no promotion record, the card assumes both checks passed** and shows `Pass (N)`. That label is a default, not an audit. Open the evidence and check that a promotion record exists. |
| **Credits spent** | `budget.spend_usd × 100`, minimum 1. | Derived from USD spend. Reconcile with the service receipt (`credits_receipt`, where available). |

Expand **Decision evidence, candidate digest & rubric lineage** and confirm:

- The **winning candidate** and **program SHA**. This is the exact artifact you
  are promoting.
- The **outbox key** `evolve:<evo id>:<program sha>`. A decision for the same
  run and winner is published only once.
- **Promotion gate:** `decision · hard pass · intervals pass` from the ledger.
- **N frozen rubric(s) verified.** The rubric digests used for scoring.

### The three buttons

| Button | Effect in this snapshot |
| --- | --- |
| **(Recommended) Promote winning version** | Records your choice in the card, shows *"Winning candidate … marked for promotion. Subsequent runs with --seed-from <target> will compound on this winner."*, and refreshes the run (`evolve.refresh`). |
| **Keep current incumbent** | Records that choice and shows *"Current incumbent retained; candidate … will not be promoted."* |
| **Open in Decisions** | Opens the published OmniOS Decision for this run, or `https://app.omnisi.ai/decisions/<decision id>` when no URL has been published yet. |

> **Important.** In this snapshot the card's choice is **local to the card**.
> Clicking it does not call `POST /api/evolve/runs/{id}/promote` and does not
> write a ledger promotion. The durable decision is the published OmniOS
> Decision. A hosted promotion uses the service route or `si_evolve
> action=promote` (below). Neither is a deployment. Verify the real destination
> if the change you approved requires one.

### How the OmniOS Decision is published

When a run settles `done`, the desktop prepares the decision **idempotently**:

1. It derives the winner metrics shown on the card.
2. It enqueues an outbox entry keyed `evolve:<evo id>:<program sha>`, with
   decision ID `dec_<evo id>_<first 8 of sha>`.
3. It writes a summary-first `page.html` and a `decision.json` to
   `<userData>/discover-omnios/<evo id>/`.
4. It adds an event to the run (*"Decision dec_… queued for OmniOS Decisions"*)
   and saves the record.

Repeat deliveries with the same key are no-ops. If a published URL appears
later, the existing decision is updated to `published`. To turn delivery off,
set `OMNI_DISCOVER_OMNIOS` to `0`, `false`, `off`, or `no`.

Decision states: `pending` → `published` → `promoted` | `kept` | `rerun`, or
`failed` if delivery failed. A third resolution, `rerun_higher_budget`, exists
in the contract for re-running with a larger budget.

### Promote a hosted winner through the service

```text
POST /api/evolve/runs/{cloudRunId}/promote    body: {}
POST /api/evolve/runs/{cloudRunId}/rollback   body: {}
```

Both return a promotion summary:

```json
{ "decision": "promoted", "candidateId": "c-22", "scoreDelta": 0.02,
  "auditSummary": "…", "promotedAt": "2026-10-16T12:00:00Z" }
```

`decision` is `promoted`, `held`, or `rolled_back`. A response of `held` means
the service's gate refused: invalid or missing evidence produces a hold, not an
invented win. The desktop client implements both routes
(`promoteHostedEvolveRun` and `rollbackHostedEvolveRun`) and stores any
`promotionSummary` it receives while polling. In this snapshot no button calls
these routes yet. Over MCP:

```json
{ "action": "promote", "run_id": "<cloud-run-id>", "candidate_id": "c-22" }
```

### Promotion checklist

Promote only when every item holds for the **exact** candidate digest:

- [ ] Hard checks pass, and enough of the evaluation produced valid results.
- [ ] Held-out improvement over the incumbent meets the spec's thresholds and
      intervals (`intervals_pass` is true).
- [ ] The challenger beat the incumbent **outright** in the incumbent
      challenge (a tie keeps the incumbent).
- [ ] A real promotion record exists. The card's `Pass (N)` default is not
      enough.
- [ ] No unacceptable **regressed** behavior deltas.
- [ ] The budget record and destination match what was originally approved.
- [ ] Any human approval required for the destination has been given for this
      exact change.

Neither an Elo rank, nor a JEV score, nor the "Recommended" label grants
permission to publish, deploy, spend more, or change a customer's account.

### Roll back

Use the supported rollback action, then read back both the artifact and the
promotion record (`rolled_back`). Never delete audit history to undo a
promotion.

## Recipe 7: Compound on the winner

Promotion feeds the next run. A local run started with `--seed-from <target>`:

- Loads the target's **best earlier and promoted candidates**.
- **Re-evaluates them on this run's data**. A prior score is not reused as-is.
- Reports each seed under **Compounding** in the run view: source run and
  candidate, prior score, whether it had been promoted, and its score on this
  run.

```bash
omni workflow run evolve --target email --seed-from email --rubric-from <rubric-sha256> --usd-cap 5 --json
```

Pass `--rubric-from` when you want the new run scored under exactly the same
rubric, so that its scores are comparable with the previous run's. If a seed's
score here is much lower than its prior score, the data or rubric has drifted.
Investigate the drift before you trust a new "improvement".

The loop is: **local run → hosted challenge → decision → seed → local run**.
Each pass should leave a promotion record, a decision, and a receipt.

## Budget guardrails

| Control | Limit | Notes |
| --- | --- | --- |
| Iterations | 1–500 | The hosted estimate defaults to 10. `si_evolve` allows 1–8 generations. |
| Patience | 1–500 | Stops after N consecutive mutations that do not improve the best score. |
| `--usd-cap` | > 0 and ≤ $1,000 | Can only lower the run's cap. jev-lab refuses a cap above the spec's group cap. |
| Hosted credits | Server quote | The badge is an estimate. Track **estimated**, **reserved**, **settled**, and **released** credits separately. |
| Spec size | 256 KiB | Hosted submissions only. |

Practical advice:

- Smoke-test with `email-smoke` and 3 iterations before running a full target.
- Use Hosted Pro to check that a spec runs end to end. Use Super Intelligence
  only when a broader search is worth roughly 2.6× the credits (450 against 170
  estimated credits at 10 iterations).
- Set patience. Without it, a run that has stopped improving uses its whole
  budget.
- More rounds and more judges cost budget even when no candidate improves.

## Troubleshooting

| Message or symptom | Cause | What to do |
| --- | --- | --- |
| *Connect your OmniRogue account in Settings before running Hosted Super Intelligence.* | No OmniRogue lease token. | Connect the account ([guide](OMNIROGUE-CONNECTOR-GUIDE.md)), then start again. |
| *Hosted Super Intelligence rejected token (401); existing OmniRogue session preserved.* | The cloud rejected the token (401 or 403). | Check the account's entitlement with the service. The desktop keeps your link. |
| *Could not read the Evolve spec … in …* | Hosted mode reads the spec on **this computer**. | Check out jev-lab at the checkout path (default `~/Repos/jev-lab-evolve`) on this computer. |
| *The Evolve spec … is larger than 256 KiB.* | Hosted size limit. | Move large fixtures out of the spec and reference them. |
| *The Evolve spec … must be a JSON object.* | The top level is a list or a scalar. | Make the spec a mapping. |
| *Give a spec path exactly when the target is a spec path.* | `target: spec` without `specPath`, or the reverse. | Use `--spec-path` alone, or a built-in `--target`. |
| *Claude is not signed in on <host> … so it cannot run on <host>.* | Local readiness failed. | Sign Claude in on that host with a subscription over SSH, or pick another host. |
| *Omnisi cloud endpoint must use https: …* | `OMNISI_CLOUD_URL` uses plain HTTP to a non-local host. | Use `https:`, or `localhost` for development. |
| *This Evolve run has no running worker to stop.* | Stop was used on a hosted run (or a run that has finished). | Use the service's controls. See [Recipe 3](#recipe-3-follow-the-tournament-live). |
| Progress card shows `polling` | The stream dropped, went idle for 45 s, or was refused. | Nothing to do: polling still decides completion. |
| Run reads `unverifiable` | No host contact for an hour. | Select **Check again**. The run may still be going. Do not start a duplicate. |
| Card shows `Pass (N)` with no promotion record | The default label from [Recipe 6](#read-the-card-before-you-click). | Check the ledger `promotions[]` before you promote. |
| The hosted run did not use the incumbent you expected | The auto-pick chose a different local run (by score, then most recent). | Set **Seed from** and `seedFromRunId` explicitly. |

## What is wired today

| Capability | Status in this snapshot | Anchor |
| --- | --- | --- |
| Local/fleet Evolve start, follow, stop, refresh | Wired | `evolve-service.ts`, `rpc/methods/evolve.ts` |
| Hosted quote, submit, and poll | Wired | `hosted-evolve-client.ts` |
| Hosted live progress (SSE) | Wired; completion still comes from polling | `evolve-hosted-stream.ts`, `evolve-hosted-progress.ts` |
| Best-local-winner auto-seed | Wired in the start form | `findBestLocalWinnerSeed` |
| Knockout bracket and family Elo | The calculations are implemented and tested; `EvolveLeaderboardDrawer` is **not mounted** in a run view yet | `evolve-leaderboard-helpers.ts`, `EvolveLeaderboardDrawer.tsx` |
| JEV screen inside the hosted tournament | Runs in the hosted service; the desktop sees the outcomes as events | Recipe 3 |
| JEV screen and pairwise ranking for your own workflows | Wired | `graph-jev-screen.ts`, `jev-rank.ts`, `jev-rank-pairwise.ts` |
| Decision card and OmniOS Decision publishing | Wired; the card's choice is local to the card | `EvolveDecisionCard.tsx`, `evolve-omnios-delivery.ts` |
| Hosted `promote` and `rollback` | Client functions exist; **no desktop caller yet** | `promoteHostedEvolveRun`, `rollbackHostedEvolveRun` |
| Hosted cancel | No desktop route | — |
| Cross-run Bradley–Terry leaderboard | Provisional service module | [Evolve guide](HOSTED-EVOLVE-SUPER-INTELLIGENCE.md#bradleyterry--elo-cross-run-leaderboards) |

## Source anchors

- Contracts: [`evolve-workflow.ts`](../../src/shared/evolve-workflow.ts),
  [`evolve-workflow-draft.ts`](../../src/shared/evolve-workflow-draft.ts),
  [`evolve-hosted-progress.ts`](../../src/shared/evolve-hosted-progress.ts)
- Hosted client: [`hosted-evolve-client.ts`](../../src/main/runtime/evolve/hosted-evolve-client.ts),
  [`hosted-evolve-schemas.ts`](../../src/main/runtime/evolve/hosted-evolve-schemas.ts),
  [`hosted-evolve-spec.ts`](../../src/main/runtime/evolve/hosted-evolve-spec.ts),
  [`hosted-evolve-events.ts`](../../src/main/runtime/evolve/hosted-evolve-events.ts)
- Runner and admission: [`evolve-service.ts`](../../src/main/runtime/evolve/evolve-service.ts),
  [`evolve-admission.ts`](../../src/main/runtime/evolve/evolve-admission.ts),
  [`evolve-service-follow.ts`](../../src/main/runtime/evolve/evolve-service-follow.ts)
- Tournament calculations and UI: [`evolve-leaderboard-helpers.ts`](../../src/renderer/src/components/evolve/evolve-leaderboard-helpers.ts),
  [`EvolveLeaderboardDrawer.tsx`](../../src/renderer/src/components/evolve/EvolveLeaderboardDrawer.tsx),
  [`EvolveExecutionModeSection.tsx`](../../src/renderer/src/components/evolve/EvolveExecutionModeSection.tsx),
  [`EvolveStartForm.tsx`](../../src/renderer/src/components/evolve/EvolveStartForm.tsx)
- Promotion: [`EvolveDecisionCard.tsx`](../../src/renderer/src/components/evolve/EvolveDecisionCard.tsx),
  [`evolve-omnios-delivery.ts`](../../src/main/runtime/evolve/evolve-omnios-delivery.ts)
- JEV: [`jev-rank.ts`](../../src/main/structured-decisions/jev-rank.ts),
  [`jev-rank-pairwise.ts`](../../src/main/structured-decisions/jev-rank-pairwise.ts),
  [`graph-jev-screen.ts`](../../src/main/runtime/workflow-script/graph/graph-jev-screen.ts),
  [`jev-rubric.ts`](../../src/shared/jev-rubric.ts), [JEV rules](../skills/jev/SKILL.md)
- Reference: [Evolve workflow](../reference/evolve-workflow.md),
  [Local and Hosted Evolve Super Intelligence](HOSTED-EVOLVE-SUPER-INTELLIGENCE.md),
  [Unified MCP reference](UNIFIED-MCP-REFERENCE.md)
