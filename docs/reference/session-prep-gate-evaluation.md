# Session prep gate: can JEV check a prepared prompt? (measured 2026-09-23)

Question: before a prepared prompt launches, which fast checks catch the defects that would make a
session fail, without adding a human step? JEV (TypeSafe `jev-1.13.0`) was compared with Claude
Haiku 4.5 and Claude Sonnet 5 on the same labelled cases.

Harness, data and raw results: `~/Work/Ops/Projects/Reverse-Prompting-JEV-Gate-2026-09-23/`
(`generate-cases.mjs`, `extra-cases.mjs`, `run-eval.mjs`, `matrix.mjs`, `coverage.mjs`, `results-*.json`).

## Data (124 cases)

12 realistic session requests from our own work (omni-ide features, omnirogue fixes, ads tooling,
a wiki SOP, a research task), each with a conversation excerpt. Per request: a good structured
prompt, a good terse prompt, and single-defect variants (vague outcome, criteria removed, a requested
part dropped, unrequested work added, a contradiction added, references removed, an unresolved
placeholder). Plus 8 hand-written pairs where the same topic (refund, deploy, rename, price change…)
either lacks a fact only the person can give or has it.

Two findings came from building the labels, before any judge ran:
- Most generated "needs the user" gaps were not user-only: they were researchable, already decided
  in the conversation, or delegated ("figure out how long to wait"). A naive check over-asks.
- Removing only the outcome or only the criteria from a rich prompt is not a real defect: the other
  sections still say what finished means. Every judge (rightly) passed most of those.

## Results (share judged defective; p < 0.5 for JEV)

| Defect | JEV | Haiku 4.5 | Sonnet 5 |
|---|---|---|---|
| Unrequested work added | 12/12 | 12/12 | 12/12 |
| Contradiction | 11/12 | 11/12 | 12/12 |
| Unresolved placeholder (`ready`) | 9/12 | 10/12 | 12/12 |
| Genuinely user-only gap (`needs_user`) | 8/8 | 8/8 | 7/8 |
| Requested part dropped (`faithful`) | 2/12 | 3/12 | 6/12 |
| **False "not ready" on 32 good prompts** | **1** | **20** | **6** |
| Latency p50 / p95 | 0.26 s / 0.40 s | 1.2 s / 4.3 s | 4.2 s / 11.3 s |

JEV answered all seven questions for all 124 cases in 6 s of wall time (one batched call per case).

## The gate that shipped

Simulated on the same data, **deterministic checks + JEV `consistent` + JEV `ready`** flagged 1 of
44 good prompts and caught 12/12 contradictions, 10/12 unrequested work, 12/12 placeholders and 7/8
user-only gaps. Sonnet alone flagged 6 of 44 good prompts at ~16× the latency.

- Deterministic first: placeholders (12/12, free), required fields, cited paths that do not exist,
  risky actions the request never mentions.
- JEV: `consistent` and `ready` below 0.5 fail and go back to the preparer for repair.
- Asking the person: the preparer proposes a question only for a user-only fact; JEV `needs_user`
  ≥ 0.8 keeps it (all 8 genuine cases scored 0.81–0.95), < 0.5 turns it into a stated default, and
  the band between goes to Sonnet. The highest false alarm on a researchable fact was 0.85, so the
  band is where JEV should not decide alone.
- Every prompt carries the person's request verbatim, so a dropped part (the defect every judge
  misses most) stays visible to the agent doing the work.

## What JEV is not used for, and why

- Dropped parts: 2/12 as one question. Asking per extracted requirement ("does the prompt require
  X?") helped on genuinely missing parts (0.24–0.74 vs good ≥ 0.78) but depends on the extracted
  requirement list; one bad extraction produced a 0.32 false alarm. Not shipped; the verbatim
  request is the safety net.
- Vague outcome and missing criteria: not reliably defects once the prompt is structured; the
  preparer's schema requires both fields instead.
- Probabilities are not calibrated (needs_user ranked perfectly — AUC 1.0 — but its 0.5 cut-off was
  wrong), so thresholds come from this data, and the mid band escalates.

## Next measurement

Every launched item records the JEV scores next to what happened (repaired, launched, asked). Once
real prompts accumulate, re-fit the thresholds on production data (JEV Lab experiment).
