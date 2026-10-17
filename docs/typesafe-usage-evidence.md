# TypeSafe / Jev: public usage evidence and Omni experiments

Research date: **September 21, 2026**. Public source inspection only; no project
installation, deployment verification, credential access, paid inference, or test
suite execution was performed for this research. Repository links below pin the
inspected revisions. Implemented code establishes an integration, not active
production adoption or improved outcomes.

TypeSafe's [official use-case map](https://docs.typesafe.ai/concepts/use-case-map)
offers candidate applications, including retrieval, routing, verification, and
classification. It is an ideas guide, not a customer-results registry. The
[direct API primitives](https://docs.typesafe.ai/introduction) are Choice, Score,
and Noul; some Vercel integrations expose probability questions as `boolean`.

## Eight inspected implementations

1. **Notra: feedback labels, chat routing, and brand analytics.**
   At `103a5dedd142444e4116dc4caa8b23a8f4f17c20`, the
   [evaluation configuration](https://github.com/usenotra/notra/blob/103a5dedd142444e4116dc4caa8b23a8f4f17c20/packages/ai/src/constants/evaluation.ts)
   names `typesafe-ai/jev` and `NOTRA_JEV_CLASSIFIERS`.
   [Feedback questions](https://github.com/usenotra/notra/blob/103a5dedd142444e4116dc4caa8b23a8f4f17c20/packages/ai/src/prompts/feedback-classifier.ts)
   use Choice for bug/feature/praise/question/other and sentiment. The
   [call site](https://github.com/usenotra/notra/blob/103a5dedd142444e4116dc4caa8b23a8f4f17c20/packages/ai/src/jobs/feedback-classifier.ts)
   still runs an LLM in parallel for the title and fallback classification.
   [Chat-routing questions](https://github.com/usenotra/notra/blob/103a5dedd142444e4116dc4caa8b23a8f4f17c20/packages/ai/src/prompts/router.ts)
   cover complexity and tool/reasoning needs;
   [GEO questions](https://github.com/usenotra/notra/blob/103a5dedd142444e4116dc4caa8b23a8f4f17c20/packages/geo-core/src/utils/geo-check-evaluation.ts)
   cover sentiment and list position. **Evidence: application code with fallbacks;
   no measured production savings or accuracy established.**

2. **OpenWork: select predefined verification checks.**
   At `89b51e22d2060d494dc4c33c83f7b1fb3e2ea0b1`, its
   [compiler](https://github.com/different-ai/openwork/blob/89b51e22d2060d494dc4c33c83f7b1fb3e2ea0b1/evals/packages/testkit/src/verification.ts)
   asks Boolean coverage and per-check relevance questions, requiring at least
   0.9 for coverage/selection. Ambiguity yields `incomplete`. The
   [adapter](https://github.com/different-ai/openwork/blob/89b51e22d2060d494dc4c33c83f7b1fb3e2ea0b1/evals/packages/testkit/src/verification-jev.ts)
   names Jev through Vercel. Jev is explicitly told not to judge application state;
   replay runs deterministic assertions without model calls. Its
   [contract](https://github.com/different-ai/openwork/blob/89b51e22d2060d494dc4c33c83f7b1fb3e2ea0b1/evals/verification-dictionary.md)
   describes experimental, uncalibrated selection and retains author-written
   required assertions. **Evidence: experimental implementation, not a proven
   correctness judge or replacement release gate.**

3. **pi-jev-router: model and thinking-effort selection.**
   At `64e103874c268195be20ad7e840e10c433232a64`, the
   [implementation](https://github.com/mejiasd3v/pi-jev-router/blob/64e103874c268195be20ad7e840e10c433232a64/index.ts)
   sends a Choice over model/effort profiles to Vercel's Jev evaluator. It pins
   the initial model to the session, then can suggest a fork when another model
   would help; its instructions account for prompt-cache losses. Optional Boolean
   questions select skills. **Evidence: implemented extension, without an inspected
   downstream benefit comparison.** Catalog descriptions of automatic per-request
   switching do not accurately describe this pinned version.

4. **TheoOliveira/pi-jev: tool/skill selection and error triage.**
   At `549c2bfa249269d0f5590658b5743801c47af369`, its
   [tool router](https://github.com/TheoOliveira/pi-jev/blob/549c2bfa249269d0f5590658b5743801c47af369/src/router.ts)
   lexically shortlists candidates, then asks one Noul per tool with a 0.65
   activation cutoff. The
   [skill router](https://github.com/TheoOliveira/pi-jev/blob/549c2bfa249269d0f5590658b5743801c47af369/src/skills.ts)
   follows the same pattern. A
   [tool guard](https://github.com/TheoOliveira/pi-jev/blob/549c2bfa249269d0f5590658b5743801c47af369/src/tool-guard.ts)
   uses Choice to classify execution failures, including missing paths, invalid
   syntax, and permission/environment problems; code supplies recovery hints.
   **Evidence: concrete integrations; measured quality or cost improvement unknown.**

5. **kenhuangus/jev-usecases: citation checks and passage filtering.**
   At `64708c71f7682a78e1d0fc8cd82f88f35fde907d`, the
   [citation checker](https://github.com/kenhuangus/jev-usecases/blob/64708c71f7682a78e1d0fc8cd82f88f35fde907d/src/jev_usecases/use_cases/citation_check.py)
   combines support Choice, faithfulness/overclaim Nouls, and evidence-strength
   Score. The [RAG filter](https://github.com/kenhuangus/jev-usecases/blob/64708c71f7682a78e1d0fc8cd82f88f35fde907d/src/jev_usecases/use_cases/rag_retrieval.py)
   scores relevance and checks usefulness, contradiction, and injection before
   selecting passages in code. Its
   [README](https://github.com/kenhuangus/jev-usecases/blob/64708c71f7682a78e1d0fc8cd82f88f35fde907d/README.md)
   explicitly says 27 successful fixture calls establish typed responses, not
   correct judgments, and that thresholds need calibration. **Evidence:
   demonstration harnesses, not established production effectiveness.**

6. **LangChain / Jev-as-a-Judge: evaluate captured agent responses.**
   At `adfea74905f721ea2594e22804c8c8edf1693163`, the
   [evaluator](https://github.com/danielgshea/jev-as-a-judge/blob/adfea74905f721ea2594e22804c8c8edf1693163/src/evals/judges/system_one.py)
   uses Nouls for groundedness, search behavior, usefulness, and pass/fail, plus
   Choice for response outcome. Its quality value averages three Nouls; it is not
   a Score primitive. The
   [published comparison](https://www.langchain.com/blog/jev-agent-evals-langsmith)
   reports human-oracle agreement on 500 repeated pass/fail judgments, 0.44 seconds
   average latency, and $0.00035 per call. **Those are five distinct weather-agent
   responses, each judged 100 times, not 500 independent examples.** The Jev service
   version was unavailable. **Evidence: a narrow author-run measurement, not broad
   accuracy or production proof.**

7. **iefnaf/pi-jev: preserve useful tool history during compaction.**
   At `cd168457a8b340352d1ae1e9e4785305954b5751`, the
   [compactor](https://github.com/iefnaf/pi-jev/blob/cd168457a8b340352d1ae1e9e4785305954b5751/src/vendor/fast-jev-compaction/compact.ts)
   asks two Nouls per tool call: retain the call and retain its full output.
   Its [evaluation writeup](https://github.com/iefnaf/pi-jev/blob/cd168457a8b340352d1ae1e9e4785305954b5751/eval/README.md)
   reports 91 real-session cases. Adding context changed size-matched AUC from
   0.507 to 0.510, with a paired 95% interval of -0.07 to +0.07. At equal summary
   size, Jev retained no more later-used content than random. String-reuse labels
   miss semantic reuse, the label audit was model-generated, and replay observes
   one step. **Evidence: an author-run negative result with important limitations.**

8. **Compozy/yoshi: semantic context pruning.**
   At `55c719718e5039f2276fbad804211682ae012f1e`, the
   [selector](https://github.com/compozy/yoshi/blob/55c719718e5039f2276fbad804211682ae012f1e/src/semantic.ts)
   uses Choice for needed/covered/irrelevant/uncertain or atomic Boolean questions
   for relevance, coverage, and contradiction. Its
   [measurements](https://github.com/compozy/yoshi/blob/55c719718e5039f2276fbad804211682ae012f1e/docs/BENCHMARKS.md)
   report 34.39% accumulated-input reduction in one Fable diagnostic, but elapsed
   time increased from 39.77 to 210.54 seconds. A separate Sonnet trial showed no
   input savings and increased from 35.14 to 171.99 seconds. Each had one trial per
   arm; missing receipts leave combined costs unknown. **Evidence: mixed author-run
   measurements. Fewer tokens did not establish lower latency or total cost.**

## Three experiments for Omni

| Experiment | Comparison and independent labels | Outcomes to measure |
| --- | --- | --- |
| Context relevance and selection | Existing retrieval, deterministic lexical/recency selection, and Jev reranking at the same token budget. Label indispensable evidence independently. | Evidence recall, downstream answer correctness, refetches, p95 end-to-end latency, and billed usage including cache effects. |
| Evidence/citation support | Deterministic source/quote existence first; Choice for supports/partial/contradicts/absent. Include related but unsupportive passages and independent support labels. | Unsupported-claim recall at a fixed review rate, false flags, abstention, calibration, latency, and cost. |
| Tool-error triage | Existing error-code rules versus Choice for transient retry/change arguments/authentication/environment repair/escalation; optionally a Noul about an unchanged retry helping. | Correct recovery recommendation, unnecessary retry rate, escalation of unrecoverable errors, and eventual recovery on a later behavioral evaluation. |

TypeSafe's [reranking cookbook](https://docs.typesafe.ai/cookbooks/rerank_typesafe)
reports top-1 retrieval improvement from 5% to 18% over 40 legal queries using
`jev-1.12`. This is a vendor demonstration on a particular dataset, not evidence
that Omni retrieval improves. The official
[jaggedness guidance](https://docs.typesafe.ai/model-jaggedness/jev-1.13)
also identifies irrelevant state, adversarial content, literal interpretation,
and numerical/date reasoning as failure sources. Keep exact computation in code
and explicitly include those relevant boundary cases.

## What the initial Omni harness can establish

The planned manual GitHub harness covers synthetic, predeclared error-triage,
evidence-support, and context-relevance cases, plus batched versus individual
questions. Those first results can establish behavior on those cases, schema
handling, repeatability, and observed provider latency/usage. They **cannot prove
production effectiveness, net savings, or improved agent outcomes**. Batching
measurements should preserve identical state/questions and report answer changes,
request counts, latency, failures, and complete usage separately.

For a later effectiveness claim, separate development and held-out data, freeze
prompts and thresholds before evaluation, use independent labels, and compare
equivalent inputs and budgets. Report sample counts as distinct cases separately
from repetitions. Include provider failures, abstentions, and unknown costs;
do not substitute agreement with another model for independent correctness.
Decisions remain advisory during evaluation. Existing required GitHub checks
remain the verification authority; this research adds no local/fleet test suite
or independent merge gate.
