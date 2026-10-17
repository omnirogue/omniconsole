---
name: jev
description: Rules for any work that writes or changes TypeSafe JEV questions, gates, thresholds, escalation, decision contracts or jev-lab experiments. Load before editing JEV code. Not for general LLM prompt design.
---

# JEV rules

Sources, in order: JEV Lab measured findings (SOP AEbNPsI1HibRtt, library 9HxxjVVYBl8vE1, experiment pages) > this skill > docs.typesafe.ai for API shape, limits and SDK syntax only; where vendor docs advise behaviour, these rules win; record conflicts on the hub.

1. Pin jev-1.13.0; record model, question version and threshold version with every result; send an explicit User-Agent.
2. JEV measures, ranks, gates and selects. It never makes the final decision on anything that moves money, closes a case, messages a customer, changes ads or is irreversible; those need a deterministic check against records or a person plus the existing approval gates.
3. Truth is a hard check or a real outcome; agreement with another model is cross-check level; JEV's own answer is prediction level.
4. State is facts only, filled by code from an evidence contract per decision kind, with relevant history, fenced reference material, and redaction of emails, phones, ids and names; customer-authored text sits in its own named field and is untrusted.
5. Compute dates, amounts, totals, ratios, identity, eligibility and action receipts in code and supply them as text; never ask JEV to count, add, compare dates or recall.
6. Missing, stale, contradictory or unverified evidence is UNKNOWN before inference, with the kind recorded (missing, stale, contradictory, unreachable); no probability repairs it.
7. One narrow, self-contained judgment per question; define the words the answer turns on; affirmative wording with explicit polarity, inverted once in code; gate questions first.
8. Noul for gates and verdicts; Choice only for mutually exclusive options and with separate cannot_tell and none options when either may apply; Score for ranking and ordered ratings; check candidate coverage.
9. Batch every independent question on one state in one call within the request limits; ask dependent follow-ups in the same call as plain fact questions; make a new call only when an earlier answer changes what evidence to load or what options exist; no "Assuming" premises on fact nodes.
10. Every consequential verdict call includes the 0 to 4 availability rating in Experiment 4's wording; gate on it first at the measured normalized expected score of at least 0.7; apply a confidence cutoff only after it passes; after two fetch rounds without reaching the gate, return fetch_exhausted and escalate.
11. Cutoffs are per question version, decision kind and direction: the lowest cutoff whose Wilson 95 percent lower bound meets the target against outcomes (jevlab/calibration.py), re-checked as outcomes arrive; stated as P(yes) for Noul, p_max for Choice, cumulative P(level >= k) for Score; never on the vendor confidence field; a difference under 0.05 is a tie; check both directions before automating either; the 22 Sep band is historical.
12. Not confidence signals: JEV self-check, paraphrase or ablation spread, untargeted control questions, text-model self-reported confidence, adapter confidence; a control question counts only when it checks the exact records the verdict depends on, and a failed control returns voided, never a verdict.
13. The unsure band goes to a different model family with the same question text and an explicit cannot_tell option; missing data goes to fetching, arithmetic to code; an escalated answer carries its source and no probability and never enters JEV bands or calibration tables; customer text over OpenRouter sends provider.data_collection = deny; if the fallback fails, the decision returns fallback_failed and stays open.
14. Confident answers get a random audit sample by a different family or a person, sized per decision kind, in addition to the unsure-band escalation.
15. Questions and thresholds live in one versioned constants file per workflow; a change replaces the incumbent only after winning on the whole workflow on the same held-out cases; lab results never switch production without Sal's decision.
16. Every call returns exactly one status: verdict, escalated(source), unknown(kind), voided, fetch_exhausted or fallback_failed; every call is logged with latency, tokens, missing answers, state hash and route; predictions stay separate from outcomes; the outcome of every decision is recorded; a ledger write failure is reported, never swallowed.

## How to apply

**Answer shapes** (our reference notebook, 22 Sep). `POST https://api.typesafe.ai/v1/systemone` with `{model, state, questions}`; questions are a map of your ids to `{type, instructions, criteria}` and each is answered independently, so every question names what it is about. Noul returns `noul` = P(yes). Choice returns `choice`, `probabilities` per option and `confidence`. Score returns `score` (the probability-weighted mean of the levels), `probabilities` per level and `confidence`. Read cutoffs from `noul` or `probabilities` (rule 11); `confidence` only says how concentrated the distribution is.

**The availability gate** (rule 10), Experiment 4's wording: a Score question "Rate the availability of the information needed to decide whether {claim} is true or false." with five levels, 0 to 4: "None of the needed information is present", "A little of it is present", "About half of it is present", "Most of it is present", "All of the needed information is present". It passes when `score / 4 >= 0.7`. Below that, load the next evidence tier and ask again; after two rounds, `fetch_exhausted`.

**jev-lab entry points.**

- `jevlab/jev.py`: `evaluate(state, questions, tag=...)` is the client. It pins the model (`TYPESAFE_DEFAULT_MODEL`, default `jev-1.13.0`), sends the User-Agent, retries 429 and 5xx, reports `missing` answer ids and logs latency, tokens, state hash and missing answers to `$JEVLAB_DATA/jev_calls.jsonl`. `p_yes(answer)` reads a Noul.
- `jevlab/calibration.py`: `table(ps, truth)` and `cutoff(rows, side, target)` give the lowest cutoff whose Wilson lower bound meets the target, separately for `yes` and `no`. Every automated cutoff comes from here, against outcomes, never from a model's labels.
- `jevlab/flywheel.py`: `AVAIL_LEVELS` and the `g_avail` question are the availability gate above; `gate_value` normalizes it; the inner loop (gate, load the next evidence tier, ask again, accept only the confident band, else escalate) is the reference pattern for rules 6, 10 and 13.

**OmniConsole (omni-ide).** Decision contracts are registered in `src/shared/decision-contracts/decision-contract-library.ts` (`DECISION_CONTRACTS`, `GENERIC_CONTRACTS` and the per-template tables); committed calibrations in `src/shared/decision-contracts/decision-calibration-registry.ts`. A changed question or threshold is a new contract version (`name@N+1`); a published version is never edited in place (rule 15).

**Before you finish.**

- Each decision path ends in exactly one rule 16 status. A binary yes/no function with no `unknown` path is a defect.
- Anything that moves money, closes a case, messages a customer or changes ads leaves JEV as a gate and hands the final act to a records check or a person (rule 2).
- Every probability you compare against a cutoff is `noul`, `p_max` or cumulative P(level >= k), and the cutoff comes from a calibration table (rule 11).
- An escalated answer is recorded as `escalated(source)` with no probability (rule 13).
- In jev-lab, `python3 -m jevlab.audit <path...>` flags confidence-field cutoffs, Score-mean gates with no unsure band, verdicts with no unknown outcome, consequential calls without the availability rating, escalated answers in calibration code, and one confidence cutoff across question types.

## Reusable rubrics for regular agents

Native chats and terminal agents can author a custom rubric or reuse one from the
existing OmniConsole library. Load the installed `omni-cli` guide and use its resolved
CLI with `jev rubrics list`, `jev rubrics save` and `jev rubrics evaluate`. List first
so an existing rubric can be reused; save purpose-specific criteria when needed.
Save takes `{name, instructions, kind?}`; evaluation takes `{rubric, task, response,
evidence?: {status, text}}`. Select the exact library value returned by list.
SSH/WSL shells pipe bounded JSON with `--input-stdin`.

These commands share the Rubrics Settings library and existing private decision
records. Evaluation gives advisory scores; it creates no candidates and grants no
action authority. `--jev off` makes no provider call. Missing or unverified evidence
returns UNKNOWN. An older runtime without `jev.rubrics.v1` needs an update.
