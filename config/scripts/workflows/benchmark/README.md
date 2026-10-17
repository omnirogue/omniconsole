# Workflow benchmark kit

Phase 0 ("Measure") of the workflow upgrade plan. The rule is simple: nothing becomes a default
until it matches or beats the current default on a frozen known-answer set, measured on real
results found, cost and time. This folder is that set, its scorers, and the runner.

It sits beside the older quality-gate scripts in `config/scripts/workflows/` (frozen manifests in
`docs/workflows/quality-gate-*.json`). Those replay frozen evidence packets through the workflow
service; this kit drives the real app end to end through `omni workflow run --json`, the same
path a person's run takes.

## What is here

| Path                                      | What it is                                                                                                                                                                                                           |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `discover-seeded/fixture/`                | A small TypeScript storefront service (8 files, ~850 lines) with 12 seeded defects and 3 decoys. It compiles (`tsc -p fixture`); nothing in it says where the defects are.                                           |
| `discover-seeded/answer-key.json`         | The key: id, file, line range, the text the range must contain (`anchor`), severity, a one-line description and the defect-specific `evidence` terms a finding must use to be credited. Decoys have `kind: "decoy"`. |
| `discover-seeded/prompt.md`               | The goal every Discover arm is given.                                                                                                                                                                                |
| `decide/questions.json`                   | 10 Council/Decide questions (5 one-answer, 5 judgment) with reference answers, a shared rubric and an (A, B) answer pair with the better one labelled. **Skeleton:** the references and labels are unreviewed.       |
| `arms/`                                   | Example arm files.                                                                                                                                                                                                   |
| `discover-score.ts`                       | Scores a Discover run against the key (pure; tested).                                                                                                                                                                |
| `decide-score.ts`                         | Scores a Council answer against the reference with JEV's rubric ranking (`jevRank`). Skeleton.                                                                                                                       |
| `noul-gates.ts`                           | Measures JEV NOUL yes/no gates against today's rules (benchmark only).                                                                                                                                               |
| `benchmark-run.ts`, `benchmark-report.ts` | The runner and the per-arm report (mean, sample standard deviation, variance).                                                                                                                                       |
| `run-workflow-benchmark.ts`               | The command.                                                                                                                                                                                                         |

## Running it

Prerequisites: OmniConsole is open (the runs happen in the app) and `omni` is on `PATH` (or pass
`--omni <path>`; on Windows pass the absolute path).

1. Copy the fixture somewhere new and add it in OmniConsole as a folder workspace:

   ```sh
   npx --yes tsx config/scripts/workflows/benchmark/run-workflow-benchmark.ts --materialize ~/bench/storefront
   ```

2. Run the arms:

   ```sh
   npx --yes tsx config/scripts/workflows/benchmark/run-workflow-benchmark.ts \
     --set discover-seeded --arms config/scripts/workflows/benchmark/arms/discover-default-vs-quick.json \
     --reps 3 --worktree path:$HOME/bench/storefront --out /tmp/bench-discover-1 --noul
   ```

   The report goes to `--out` as `report.md` and `report.json` (every run's full result and
   score), and to stdout.

3. The decision set, one Council per question, each scored against its reference:

   ```sh
   npx --yes tsx config/scripts/workflows/benchmark/run-workflow-benchmark.ts \
     --set decide --arms config/scripts/workflows/benchmark/arms/decide-council.json \
     --reps 2 --worktree <any workspace> --out /tmp/bench-decide-1 --judge --noul
   ```

   With `--gates-only --noul` it measures the two decision-set gates (one-answer routing and the
   final check) without running a workflow at all.

Flags: `--reps` (1–20), `--omni`, `--worktree` (any selector `omni workflow run` takes),
`--noul` (ask the NOUL gate questions), `--judge` (score Decide answers with JEV),
`--attempts-dir <userData>/local-workflow-attempts` (read the screen certainty a run kept, see
below), `--gates-only` (decide set only).

An **arm** is `{ "name", "template", "specFile"?, "routes"?, "models"?, "runsOn"?, "requestedBy"?,
"request"? }`. `template` is any of
`discover | council | improve | best-of-n | find | decide | investigate | quick-discover`; `specFile`
is a JSON object laid over the template (`omni workflow run --spec-file`: top-level fields replace,
`"steps"` as an object patches steps by id, as a list replaces them), resolved against the arms
file's folder; `routes` limits the model families. `models`, `runsOn`, `requestedBy` and `request`
are passed as `--models`, `--runs-on`, `--requested-by` and `--request`; an arm without them runs
exactly as before.

`arms/discover-d9-matrix.json` is the D9 re-run (the 12-bug set): **A** default Discover; **B**
cheap finders with frontier verify and report; **B2** cheap finders with standard verify and report;
**C** Quick Discover on the 1M Opus 5.5 seat (`arms/quick-discover-1m.json`); **A55** arm A as it
ran until 13 Oct 2026, with every Claude seat on Opus 5.5 (`claude-opus-5-5[1m]`, the only Opus 5.5
the workflow catalog offers). Every arm runs `--runs-on local`. A55 spells out that lineup's seats
for a Claude + Codex + Grok computer (Studio's benchmark seats); on one without Grok, change its
lists to
`find=claude:claude-opus-5-5[1m],codex,claude:claude-opus-5-5[1m];verify=codex,claude:claude-opus-5-5[1m],codex`.
Since 13 Oct arm A's Scout and Find run on Haiku 5.5 (`docs/workflows/DISCOVER-OMNIOS.md`), so A55
now differs from A in its finders as well as the Claude model. Started from an agent session, the Discover
arms need `requestedBy` and `request` (the person who approved the run and their words), and arm C
is refused: a person starts it. The runner goes arm by arm; for the interleaved order (A1 B1 … A2
B2 …), run `--reps 1` once per round. Quick Discover is one read with no verify step, so every C
target is unverified: C's Recall, precision, High in top K and MRR are 0 or "–" and "Missed by C"
lists all 12 by construction. Compare C with the other arms on **Recall (any verdict)**.

## What it costs, roughly

- A Discover run on the fixture: about the cost and time of Discover on an ~850-line workspace:
  typically 15–40 agent calls and 10–40 minutes, so a few dollars of frontier-model usage per run.
  Three reps of two arms is six runs. Per-call tokens are in the report where the app recorded
  them; **price is always "unknown"** because the app records no price for agent calls.
- A Decide run is one Council per question: 10 questions × reps × arms Council runs.
- JEV (TypeSafe) calls are cheap: `$0.042` per million input tokens (the tariff in
  `decision-experiment-metrics.ts`). The NOUL gates ask one question per finding (two per pair for
  the final check), well under a cent per report. `--judge` adds two rubric calls per answer.

## What the report says

Per arm, over repetitions (mean ± sample standard deviation):

- **Recall**: seeded bugs a _confirmed_ target was credited with, of 12. **Recall (any
  verdict)**: seeded bugs any target was credited with, confirmed, refuted or unverified (12 minus
  `discover.missedEntirely`); the only recall for a single-pass arm such as Quick Discover.
- **Precision (unique defects)**: unique seeded bugs found, of those plus every confirmed target
  that credits no bug (decoys, other findings, adjudication); duplicates count in neither.
  **Precision (per target)**: confirmed targets crediting a seeded bug, duplicates included, of
  all confirmed targets. **Duplicates**: confirmed targets that repeat a bug already credited.
- **Decoys flagged**: decoys a confirmed target matched. **Other findings**: confirmed targets
  that match nothing in the key (they may be real defects the key does not have; read them).
- **High in top K / MRR**: the confirmed list ranked by the run's own value signal (JEV screen
  score, then severity); K is the number of critical and high seeded bugs; MRR is the mean
  reciprocal rank of those bugs (0 for a missed one).
- Per-verdict groups (confirmed / refuted / unverified) are in `report.json` under each run's
  `discover.byVerdict`, with every target's match.
- **Wall clock** (host start to settle) and **tokens** (reported by the calls; runs without
  them are counted as unknown, never 0).

Matching: a target is credited with a key entry only when its location names the entry's file
(suffix match), its lines overlap the entry's range within 3 lines, and its title or detail
contains at least one of the entry's `evidence` terms. When several entries fit equally the
target is ambiguous; a fit without overlapping lines or without evidence is weak. Ambiguous and
weak targets are listed under **Needs adjudication** (`needsAdjudication` in `report.json`, with
the candidate ids) and are never credited.

Decide: every attempt keeps its question id. Within each repetition the arm's score is the mean,
over the **matched questions** (those every arm scored in every repetition), of the run's JEV
rubric score minus the reference's; mean and standard deviation are across repetitions. Attempts
without a score (the run failed, the judge failed, or `--judge` was off) are listed under
**Unscored**, never counted as 0.

### Yes/no gates (NOUL against today's rule)

Measured only here; no live workflow reads them. For each gate the report gives NOUL's Brier
score, accuracy at thresholds 0.3–0.7, the share inside the unsure band 0.35–0.65 (which would go
to a frontier model instead) and cost per decision, beside today's rule.

1. **Set-aside** (Discover): NOUL "is this a real, in-scope defect?" per finding, against the
   screen rule (JEV score ≥ `WORKFLOW_SCREEN_SET_ASIDE`, or reported more than once). Two views:
   findings the key knows (seeded = yes, decoy = no) and every finding (unkeyed = no). The rule's
   probability is the screen's P(score reaches the line) from the level probabilities the run kept
   (`--attempts-dir`, recorded since #633), else score/4.
2. **One-answer routing** (decide set): NOUL "does this question have one right answer?" against
   the labels. No rule routes this today, so the baseline is "every question is judgment".
3. **Final check** (decide set): NOUL "is B better than A?" asked in both orders (the average of
   p(B|A,B) and 1 − p(A|B,A)), against today's both-orders `jevRank` pairwise ranking.

NOUL's unsure band is 0.35–0.65. Today's rules are reported with their own unsure decision: the
pairwise ranker's (a 0.2–0.8 band on its both-orders probability, or the two orders disagreeing),
and none for set-aside and one-answer routing, which never defer. A run's tokens are compared only
when every call reported them; a partial count is shown as unknown.

## Direct agent versus coordinated workflow

A separate, smaller question from the sets above: on the same bounded implement task and the same
brief, what does coordination cost and buy? It does not run Discover or Council.

| Path                            | What it is                                                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `implement-bounded/fixture/`    | Three stub functions with a written spec (`SPEC.md`) and public checks. Plain Node, no dependencies.                            |
| `implement-bounded/acceptance/` | Hidden acceptance checks, copied in only when QA runs. `reference/` holds solutions that pass them; an agent never sees either. |
| `implement-bounded/tasks.json`  | The frozen task list (version 1). To change a task, its spec or its checks, add a new version.                                  |
| `direct-vs-coordinated-*.ts`    | The stage runner, the two arms and the report (tested with fakes in `direct-vs-coordinated.test.ts`).                           |
| `agent-transcript-usage.ts`     | Token counts from a Claude or Codex transcript; unreadable means unknown.                                                       |
| `run-direct-vs-coordinated.ts`  | The command.                                                                                                                    |

The two arms:

- **direct**: one agent gets the `implement` brief. Then the hidden checks run. If they fail, the
  failure is carried back in a repair brief; with no workflow that is a person's job, so it counts
  as one human intervention (with zero thinking time, which makes direct wall clock a lower bound).
- **coordinated**: the same `implement` brief, then an `independent-review` by a different model
  family only when the brief touches a guard family (`independentReviewTriggers`), then the hidden
  checks as deterministic QA, then at most one repair when QA fails or the review blocks.

Both arms start their agents through the existing executor (`omni orchestration task-create` and
`worker-start --close-on-completion`), one worker at a time. The script is the coordinator; it adds
no scheduler.

```sh
# once: a new folder, added in OmniConsole as a folder workspace
omni repo add --path ~/bench/implement-bounded --kind folder
# from a terminal that is the coordinator of a Run
omni orchestration run-create --objective "Benchmark: direct vs coordinated" --json
npx --yes tsx config/scripts/workflows/benchmark/run-direct-vs-coordinated.ts \
  --workspace ~/bench/implement-bounded --run <run_id> --out /tmp/bench-direct-1 \
  --reps 2 --implementer claude:claude-sonnet-5-5:medium --reviewer codex
```

Flags: `--reps` (1–5), `--tasks <id,id>`, `--arms direct,coordinated`, `--implementer` and
`--reviewer` as `agent[:model[:effort]]`, `--omni`, `--host`, `--owner`.

The report (`report.md`, `report.json`, and `runs.partial.json` while it runs) gives, per arm:
runs, hidden-check passes (verified, and verified on the first QA run), mean wall clock split into
agent time, QA time and coordination time (task creation, launch, waits, release), agent
dispatches, retries, human interventions, errors and tokens; and per task the coordinated wall
clock over the direct one.

What it does not say:

- Tokens come from each agent's own transcript. One stage whose transcript cannot be read makes the
  arm total unknown (the known part is listed beside it). Cost is always unknown: no seat price is
  recorded.
- The coordinator is a script. A coordinating agent adds its own time and tokens, which are not
  measured here.
- Three small tasks say nothing general about throughput. A run that errored counts as a run and an
  error, never as a time. A worker that waits on a person is counted and left alone, never stopped.

## Adding a set

1. Add a folder beside `discover-seeded/` with its material and a key. For a Discover-style set,
   keep the answer-key shape (`discover-score.ts` `AnswerKey`) and give every entry an `anchor`:
   `discover-score.test.ts` fails when a fixture edit moves a range away from its anchor.
2. Freeze it: bump `version`, set `frozenAt`, and never edit a frozen set in place — add a new one,
   so earlier reports stay comparable.
3. Add the set name to `BenchmarkSet` in `benchmark-run.ts` with its runner branch, and a test
   that scores a recorded result (see `benchmark-fakes.ts`).

## Calibrating a decision contract

A decision contract (`src/shared/decision-contracts/`) says how JEV makes one kind of decision. Calibrating it
means checking JEV's decisions against known answers. The known answers are a **golden set** in
`golden/<contract-id>/v<N>.json`: each item holds exactly what JEV is shown (`state`) and the right answer
(`truth`). For a gate or route, the truth is `yes` or `no` (for a score line, `yes` means the item reaches the
line and is kept). For a pair, it is `a` or `b`, where `b` is the answer that would replace `a`. `unknown` and
`tie` are reported but never counted as agreement. A golden set is frozen: to change it, add `v<N+1>.json`.
Never edit a version in place.

### What exists today

| Set                   | Items               | From                                                          | Status                 |
| --------------------- | ------------------- | ------------------------------------------------------------- | ---------------------- |
| `discover-set-aside`  | 15 (12 yes, 3 no)   | `discover-seeded/answer-key.json`: seeded bugs yes, decoys no | skeleton, labels `key` |
| `decide-one-answer`   | 10 (5 yes, 5 no)    | `decide/questions.json`: one-answer yes, judgment no          | skeleton, labels `key` |
| `decide-compare-line` | 10 pairs (4 a, 6 b) | `decide/questions.json` pairs, overall-better label           | skeleton, labels `key` |

No person has reviewed these labels, and every set is far below the item counts that calibration needs. So
each can reach **measured** at most, never **calibrated**. The decoy findings' wording was written from the
key (the key describes decoys as correct code, not as findings). Their labels are the key's.

### Labelling a set

1. A person reviews every item. A yes/no contract needs at least 80 labelled items (`GATE_TARGET`), and at
   least 10 on each side. A ranking needs at least 40 pairs (`RANKING_TARGET`). With no misses, a 5% target
   needs at least 73 decisions that JEV made alone.
2. Labels come from an answer key, from that person, or from a frontier model offline and then checked by the
   person. A calibration never makes live frontier calls.
3. Save the set as a new version with `status: "reviewed"`, the reviewer's name in `reviewedBy`, and `labels`
   set to `key`, `person` or `frontier:<model>`.

### Running it

```sh
TYPESAFE_API_KEY=… npx --yes tsx config/scripts/workflows/benchmark/calibrate-contract.ts \
  --contract discover-set-aside@1 --out /tmp/calibrate-set-aside-1
```

It asks JEV about every item through the live call (`jevScreen`, `jevRank` or `jevDecide`), using the
contract's own confidence policy. It needs `TYPESAFE_API_KEY` and refuses without it. It never makes up
results. It writes only to a new `--out` folder:

- `<id>.v<N>.json`: every row (decision, probability, band, agreement and tokens) and the summary.
- `report.md`: each band's items, disagreement and Wilson 95% upper bound, plus escalation share, Brier
  score and cost.

`--golden <file>` picks a set other than the newest version of the contract's own set.

### Committing the result

Copy `<id>.v<N>.json` into `src/shared/decision-contracts/calibration/` in a PR. CI
(`decision-contracts-calibration.test.ts`) fails in these cases:

- the file is stale: the contract, the golden set or the JEV model has changed since it ran;
- its rows or summary don't recompute;
- a default contract is neither calibrated nor in `UNCALIBRATED_ALLOWED`.

When the file makes a contract **calibrated**, remove it from `UNCALIBRATED_ALLOWED` in the same PR. CI
requires this. A default that `replaces` another contract also needs both calibration files on the same
golden set. The new contract must be at least as accurate, have no higher a costly-side error bound, and
keep its confident-disagreement bound within target.

## Discover L8 measurement rules

Quick Discover reads the complete admitted scope and renders its report and ranking in code.
Explicit Quick runs remain single pass. The small-scope routing path adds an independent Verify
step when another family is available. Explicit small
file/folder selections using an unchanged Discover template route to this path when the entire
scope fits; custom templates, remote workspaces and larger scopes keep Discover. Quick refuses
scan/file caps or skipped source files before launching any call.

D9 arms pin expected resolved provider/model IDs for every step. A mismatch invalidates the run.
B changes Find only; B2 changes Verify from B; R changes Report from B; B2R crosses those two;
S55 changes Scout only; A55 changes Find's model only. C is the distinct whole-scope algorithm.

Ranking is scored through the same complete actionable ordering as the decision page. Strict
precision counts unkeyed findings as false positives; keyed/adjudicated precision excludes
unlabelled findings. `scoreDiscoverRun` accepts explicit `real`/`false` labels by finding key;
`runBenchmark` accepts them by execution ID in `adjudications`. These labels never alter the
answer key. Any-verdict precision and decoys cover single-pass Quick. JEV's stored verify
probabilities receive an answer-key Brier score, and its live verdicts are counted separately
from reviewer verdicts. Round totals retain targets and round-tagged call costs.

Costs include known bills from every terminal attempt, including failed attempts and failed
runs. Unknown and partial run totals are counted separately and excluded from the cost mean.
Per-round known costs are subtotals, not assertions of complete cost.

`discover-defaults.test.ts` guards future default-model changes with committed paired
`discover-seeded` results under `promotions/<template>.json`: `{ set, version, choices, previous,
candidate }`. The candidate must use the proposed resolved models, improve recall, precision or
ranking, and regress none of them. The explicitly recorded pre-gate baseline is grandfathered:
there is no committed Discover comparison proving those existing defaults won. No such receipt
was invented; obtaining it needs authorization for model-budget benchmark runs.
