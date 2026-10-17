// One home for JEV's sureness rules, so a decision contract never describes a rule the runtime lacks.

/** Overall rubric scores closer than this (0–4) do not separate two answers. */
export const JEV_SCORE_MARGIN = 0.5

/** JEV Lab, 2026-09-22 (4,786 judgments): 27% disagreement with Opus inside, 0.1% outside 0.1–0.9. */
export const JEV_UNSURE_BAND = [0.2, 0.8] as const

/** JEV rules 11: two probabilities less than this apart are a tie. */
export const JEV_TIE_MARGIN = 0.05

/** Head to head costs n(n−1) calls; above this many answers, rubric scores (n calls) are used. */
export const JEV_AUTO_PAIRWISE_MAX = 5

/** Word for word the question the phase-0 kit measures (benchmark/noul-gates.ts, PR #644). */
export const ONE_ANSWER_QUESTION =
  'Does state.question have one right answer that could be checked (a fact, a computation or a lookup), rather than calling for judgment between reasonable positions?'

/** The JEV model every call asks for; a calibration measured on another model no longer counts. */
export const JEV_MODEL = 'jev-1.13.0'

/** Discover's JEV verify: asked after each finding's own report, in the benchmark's wording. */
export const JEV_VERIFY_QUESTION =
  'Looking at the code, is this a real, in-scope defect (the scope is state.scope) that the reviewer describes correctly?'

/** JEV Lab, 2026-09-26: p >= 0.9 caught 7-9 of 12 seeded bugs at precision 0.58-0.64. */
export const JEV_VERIFY_BAND = [0, 0.9] as const

/**
 * Live JEV verify under discover-verify@2, and a step's own `confirmAt` since: an item the
 * reviewers left unverified is confirmed at p >= this. Benchmark, 2026-09-27: in the 3 of 6 runs
 * that under-confirmed, recall 0.42/0.33/0.58 -> 0.75 each, at equal or better precision.
 */
export const JEV_VERIFY_CONFIRM_AT = 0.9
/** The `confirmAt` a step may set: never below the band it was measured around, never certainty. */
export const JEV_VERIFY_CONFIRM_RANGE = [0.8, 0.99] as const

/**
 * Live JEV verify's default since 2026-09-28: an item the reviewers left unverified is set aside at
 * p <= this, and nothing is confirmed. JEV Lab Experiments 5-6 (712 candidates, 12 Discover runs):
 * p <= 0.1 set aside 32+30 storefront and 9+10 workqueue items, none a seeded bug; p >= 0.9
 * confirmations matched a seeded bug only 51-79% of the time.
 */
export const JEV_VERIFY_REJECT_AT = 0.1
/** The `rejectAt` a step may set: never far past the p <= 0.1 that was measured. */
export const JEV_VERIFY_REJECT_RANGE = [0.01, 0.2] as const
