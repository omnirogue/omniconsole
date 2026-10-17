# <Audit title>

<State the question, the evidence-supported conclusion, and the highest-value next action.>

## Corpus and coverage

| Field | Observed value |
| --- | --- |
| Run / program / schema versions | <IDs and versions> |
| Execution host | <Host that owns this run and source reads> |
| Corpus identity | <Manifest/content digest; no credentials or private source bodies> |
| Selection rule and window | <Event time, modification time, or explicit selection; timezone> |
| Sources inventoried / included / excluded | <Counts and exclusion reasons> |
| Sources read / expected | <Distinct source IDs, not agent count> |
| Chunks read / expected | <Counts; list missing chunks> |
| Clipping / oversized sources / missing metadata | <Observed limitations, or none> |

<Explain what this corpus cannot prove: for example, source statements of completion do not prove
external execution, and omitted tool results cannot be reconstructed from summaries.>

## Verified findings

| ID | Finding | Distinct supporting sources | Evidence verdict | Impact | Status today | Next action |
| --- | --- | ---: | --- | --- | --- | --- |
| <T1> | <Concrete claim> | <Count computed from source-ID union> | <confirmed/weakened/refuted> | <Ordinal rubric score and origin> | <unaddressed/planned/in-progress/shipped-not-adopted/shipped/unknown> | <Action and owner> |

For each retained finding:

- **Evidence:** <Source IDs, dates, short quotes and source-check outcomes. Never publish private
  transcripts by default. Distinguish quote presence from the reviewer's interpretation.>
- **Limits or counterevidence:** <What narrows the claim, changed/unreadable sources, contradictions.>
- **Recommendation:** <Change, owner, effort, first step, metric, dependencies, adoption versus building.>
- **Expected benefit:** <Measured benefit with method, or an explicitly unmeasured hypothesis.>

## What the second pass found

- **Agreement sample:** <Sample selection; per-sample A total/matched and B total/matched;
  `(A matched + B matched) / (A total + B total)`, undefined for zero denominator. Missing
  judgments remain missing. Explain that extraction overlap is not an accuracy score.>
- **Novelty:** <Rounds, lenses, candidates and admitted IDs; say when the valid result was empty.>
- **Unmatched and contradictory findings:** <IDs, source evidence and disposition; include
  findings only the second reader found. One pass does not establish saturation.>

## Plan comparison and recommendation

<Name planner angles and judge independence. Show criterion scores, code-computed totals,
ties, fallback/unknown decisions, winning plan, and any ideas adopted from other plans.>

| Priority | Initiative | Finding IDs | Owner | Effort | First step | Success measure |
| --- | --- | --- | --- | --- | --- | --- |
| <1> | <Specific initiative> | <T1, N2> | <Owner> | <S/M/L> | <Concrete step> | <Observable outcome> |

## Set aside, unresolved, or already addressed

| Finding ID | Disposition | Evidence / impact / status reason | What would change it |
| --- | --- | --- | --- |
| <ID> | <Dropped, incomplete verification, adoption, deferred> | <Specific reason> | <Missing evidence or changed condition> |

<The survival rule excludes an evidence or impact refutation. Status annotates a finding;
it does not silently drop it. Missing required judgments prevent claiming a complete audit.>

## Completeness check

<Independent facts/requirements the critic received, uncovered gaps, unsupported claims,
ready/revise verdict, whether revision ran, and any remaining concern. Do not call a revision
re-reviewed unless another recorded review actually occurred.>

## Execution and judgment record

<Link retained run outputs and test/probe evidence. List completed/failed stages, cache reuse,
calls, measured elapsed time, known token/cost coverage, and unknown measurements. Separate
synthetic fixture results from real inference, and code presence from deployment.>

<For typed judgments: record contract version, model, Score/Noul meaning, uncertainty, fallback,
and the independently verified outcome if available. A score is not a calibrated probability;
a judgment never grants action, merge, publication, or deployment permission.>

## Open questions

1. <The highest-value scope or adoption decision.>
2. <The next measurement or owner needed.>
3. <The remaining tradeoff requiring the requester's judgment.>
