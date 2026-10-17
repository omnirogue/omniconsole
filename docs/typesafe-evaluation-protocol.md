# Typesafe evidence protocol — 2026-09-21

This is an optional experiment, not a runtime dependency, release gate, or permission to promote a provider. Ordinary sessions and deployed feature flags are unchanged. No advertisements, budgets, receipts, routing, or production data are modified by these experiments.

## What is being tested

| Experiment | Question | Comparators | What would not establish benefit |
| --- | --- | --- | --- |
| Error triage | Does semantic classification resolve negation/paraphrases better than our current classifier? | Actual production `classifyAgentTurnFailure`, Typesafe Jev 1.13, Gemini 3.8 Flash | Winning against a keyword baseline on deliberately difficult synthetic examples is not a population estimate. |
| Evidence support | Can the provider distinguish complete support, partial support, contradiction, and absence? | Typesafe Choice + Noul and equivalent Gemini structured answers | Valid JSON or a high Noul value does not establish that a claim is true. |
| Context relevance | Can it rank whether a document answers a specific query? | Typesafe Score and equivalent Gemini score | A relevant-looking document score does not prove token reduction preserves downstream answers. |
| Multi-question batching | Are two questions about one state cheaper/faster together than two sequential calls? | Same Typesafe model, same four development states and questions, AB/BA order | Repeated development states are not new independent quality evidence; batching may change answers. |

The corpus has **48 authored synthetic cases**: 16 per task, with 4 development and 12 holdout per task. Labels and rationales were authored before live calls. Paraphrase families cannot cross splits. Holdout means prompts were frozen before observations; it does **not** mean independent authors, blinded labelling, representative sampling, or externally validated ground truth. Negation, missing evidence, changed entities, numbers, historical statements, and instructions embedded in evidence are included deliberately.

Only `state` and `questions` are sent as model context. Case IDs, expected answers, rationale, family, and split stay evaluator-side. The production request validator and Typesafe adapter are reused; the existing classifier is imported, not reconstructed. The comparison model is pinned to `gemini-3.8-flash`; a different returned model fails rather than silently substituting one.

## Measurements and interpretation

- Report development and holdout separately, including all failures, skips, and missing observations. Do not cherry-pick successful calls.
- A case is correct only when every question is correct. Also report individual-question accuracy and confusion matrices. Choice is exact; Noul uses the predeclared 0.5 decision threshold plus Brier error; Score uses the corpus tolerance (0.5).
- Treat a false evidence `supports` verdict as a critical false positive. Do not infer authorization from any prediction.
- Wilson 95% intervals are descriptive case-level intervals. Related cases violate independence; do not use these intervals as a promotion test. Larger real evaluations need family/session-level resampling.
- Compare latency and estimated cost only on matched IDs with complete measurements. Report coverage, median, descriptive p95, errors, and missing usage. No zero-filling absent cost. Gemini thinking tokens count toward output cost when reported.
- AB/BA counterbalancing reduces simple warm-up/order bias; one sample per case does not establish a stable p95. Extra batching calls are separate from main quality denominators.
- Published-price estimates are not bills. Typesafe output-token price is zero, not proof that total workflow cost falls. Gemini cached input is conservatively priced at full input rate, potentially overstating its cost. Missing thinking usage leaves its cost unknown.
- Confidence/probability calibration, downstream task success, current routine token totals, cache effects, retry cost, and production data representativeness are not proved by this pilot.

## Execution and security

Offline regressions are discovered by the repository's existing Vitest configuration and run through its required GitHub checks. **Do not run suites on Sal's Mac or start duplicate fleet suites.** No schedule or legacy objective-testing job is added or enabled.

The separate **Typesafe Evaluation** workflow is manually dispatched, only on `main-next`, with the exact checked commit SHA and an explicit split. A PR-only registration job does no inference and reads no credentials. Live execution uses a dedicated `typesafe-evaluation` GitHub environment restricted to the `main-next` branch. Its encrypted environment secrets are `TYPESAFE_EVALUATION_KEY` and `GEMINI_EVALUATION_KEY`; plaintext never belongs in this repository or an artifact.

Each invocation is bounded to 48 cases, 108 provider requests including the batching experiment, 16 KiB per serialized wire request, no retries, 5 seconds per Typesafe call, 30 seconds per Gemini call, and a 12-minute admission window. An arm stops immediately on credential, model, or request-contract errors, or after three consecutive other failures. The other arm can continue. A reported-cost stop of $0.25 excludes unreported charges and is **not** a guaranteed billing cap. Incomplete runs return nonzero and preserve their sanitized observations; do not relabel a partial run a successful benchmark.

Dependencies install with the existing frozen, script-free CI action before inference credentials enter the runner step. HTTP destinations are fixed, redirects are rejected, and response size/structure is bounded. Artifacts contain predictions, usage, timing, and aggregate metrics, not prompts, credentials, raw provider errors, customer records, or session transcripts. Retention is 30 days. The workflow never imports the Electron app lifecycle or writes its state.

## Predeclared path toward useful production evidence

1. **Synthetic contract pilot (implemented here):** establish whether requests work, scoring catches mistakes, usage is measurable, and any promising signal warrants a larger study. Publish negative findings too. Do not tune on holdout after inspecting it; version a fresh corpus for another attempt.
2. **Independent real-data study (not yet collected):** sample consecutive, authorized, redacted cases from the intended workflow, not just failures or favourable examples. Split by session/customer/time, preserve a frozen holdout, obtain two independent labels and adjudicate disagreements. Record exclusions before unblinding. Synthetic author labels cannot stand in for this step.
3. **Paired shadow evaluation:** existing production remains authoritative. Compare the same cases and measure downstream task outcomes, human escalations, calibration, abstention coverage, latency, token usage, cache misses, and total retry-inclusive cost. Do not send customer/session content to another provider without the applicable data permissions.
4. **Promotion decision:** predeclare the acceptable risk for that specific capability. For an initially low-risk classifier, a candidate criterion is quality non-inferiority within 2 percentage points and at least 20% total cost reduction, without more than 5% p95 latency regression. These are proposed study thresholds, not presently passed acceptance gates. Choose sample size from expected disagreement/effect size and session clustering before the study; 36 synthetic holdout cases cannot demonstrate these margins.
5. **Consequential workflows:** retain deterministic policy, explicit human approval where required, idempotency, real-state verification, and the kill switch even after a quality win. For an unsafe-false-positive rate below 1%, zero observed failures in roughly 300 independent negative cases is only a rough one-sided 95% bound, not a guarantee or substitute for authority checks.
6. **Small reversible rollout:** move one qualified capability at a time to a canary; track the old baseline concurrently and disable on regression. Normal-session Judge/Verify/Done When outputs cannot mint receipts just because a model predicts PASS.

## Additional research candidates, not activated

- **Support classification:** benchmark bug/feature/question and urgency against the existing queue labels. Evaluate routing harm and minority-class recall, not just overall accuracy. Never auto-send a response as part of a classifier experiment.
- **Model/skill routing:** compare fixed-model and session-sticky routing using task completion, cache reuse, end-to-end time, and total spend. A cheaper selected model can lose its savings through worse reasoning or cache misses.
- **Tool-error recovery:** score a suggested recovery category first; execution remains the existing policy's job. Retry count, successful recovery, and duplicated side effects are key outcomes.
- **Retrieval/reranking:** measure relevance and downstream answer correctness with the same retrieval pool and token budget. Include lexical and random same-budget controls.
- **Context selection/compression:** require equal-token-budget baselines and real downstream task success. Published community experiments include null and strongly slower results; do not infer value from compression ratio alone.
- **Semantic lint, citation checks, and review assistance:** assess known defect recall and false alarms against independently labelled evidence; keep these findings advisory until qualified.
- **Natural-language test selection:** choose existing deterministic assertions, then actually execute them in the authorized CI workflow. Selecting a test is not running it or passing it.

See [the pinned public implementation evidence](typesafe-usage-evidence.md) for source links, measured caveats, and distinctions between real code, examples, and proven effectiveness.
