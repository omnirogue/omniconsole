import type { WorkflowSpec } from './workflow-graph'
import { decideGuardIsGap, decideGuardNote, type DecideSkeptic } from './workflow-decide-guard'

export type CouncilFinalCheck = {
  result: 'chair' | 'first-opinion' | 'inconclusive' | 'failed' | 'finished-early' | 'no-peer-votes'
  judgedBy: ('jev' | 'models')[]
  /** Decide's guard: the memo against the best finalist (graph-decide-guard.ts). */
  subject?: 'decide'
  /** Decide's skeptic (workflow-decide-guard.ts). */
  skeptic?: DecideSkeptic
}

type Translate = (key: string, fallback: string) => string
const english: Translate = (_key, fallback) => fallback

export function councilFinalCheckNote(
  check: CouncilFinalCheck,
  translate: Translate = english
): string {
  if (check.subject === 'decide') {
    return decideGuardNote(check, translate)
  }
  switch (check.result) {
    case 'chair':
      return translate(
        'workflowGraph.finalCheck.chair',
        "Final check: the chairman's answer was compared blind with the best first opinion and kept."
      )
    case 'first-opinion':
      return translate(
        'workflowGraph.finalCheck.firstOpinion',
        'Final check: the best first opinion was judged better, so it is shown instead.'
      )
    case 'inconclusive':
      return translate(
        'workflowGraph.finalCheck.inconclusive',
        "Final check: the comparison was not decisive, so the chairman's answer was kept."
      )
    case 'failed':
      return translate(
        'workflowGraph.finalCheck.failed',
        "The final check could not run, so the chairman's answer is shown unchecked."
      )
    case 'finished-early':
      return translate(
        'workflowGraph.finalCheck.finishedEarly',
        'The final check was skipped: the run finished early.'
      )
    case 'no-peer-votes':
      return translate(
        'workflowGraph.finalCheck.noPeerVotes',
        "The final check was skipped: Peer rankings counted no votes, so the chairman's answer is shown unchecked."
      )
  }
}

/** The check's outcomes the run reports as gaps: nothing checked, or nothing that passed. */
export function councilFinalCheckIsGap(check: CouncilFinalCheck): boolean {
  return check.subject === 'decide'
    ? decideGuardIsGap(check)
    : ['failed', 'finished-early', 'no-peer-votes'].includes(check.result)
}

export function councilFinalCheckDescription(translate: Translate = english): string {
  return translate(
    'workflowGraph.finalCheck.description',
    "A final blind comparison checks the chairman's answer against the best first opinion and shows the first opinion only if it is judged better."
  )
}

/** The final check as a saved or compiled spec carries it, with its step ids mapped. */
export function normalizeFinalCheck(
  raw: unknown,
  mapId: (value: unknown) => string | undefined
): Pick<WorkflowSpec, 'finalCheck'> {
  const check = raw as { rank?: unknown; chair?: unknown; skeptic?: unknown } | undefined
  if (!check || typeof check.rank !== 'string' || typeof check.chair !== 'string') {
    return {}
  }
  // Any skeptic is kept, even one that names nothing, so validation refuses it out loud.
  const skeptic =
    check.skeptic === undefined
      ? undefined
      : typeof check.skeptic === 'string'
        ? mapId(check.skeptic)!
        : ''
  return {
    finalCheck: {
      rank: mapId(check.rank)!,
      chair: mapId(check.chair)!,
      ...(skeptic !== undefined ? { skeptic } : {})
    }
  }
}

export function councilFinalCheckSteps(spec: WorkflowSpec) {
  const rank = spec.steps.find((step) => step.id === spec.finalCheck?.rank)
  const chair = spec.steps.find((step) => step.id === spec.finalCheck?.chair)
  return !spec.repeat &&
    !spec.find &&
    rank?.kind === 'rank' &&
    !rank.forEach &&
    chair?.kind === 'synthesize' &&
    !chair.forEach &&
    chair.inputs.includes(rank.id) &&
    !spec.steps.some((step) => step.inputs.includes(chair.id))
    ? { rank, chair }
    : undefined
}

export function councilFinalCheckInvalid(translate: Translate = english): string {
  return translate(
    'workflowGraph.finalCheck.invalid',
    'Final check needs Peer rankings followed by a final chairman step outside a loop.'
  )
}

/**
 * The seam for the win/lose decision itself, kept free of graph-runtime types and I/O so a
 * future JEV NOUL decider can be swapped in behind a new optional spec field without touching
 * the graph step or the renderer. Input is plain judging facts; output is the plain verdict.
 */
export type CouncilFinalCheckJudgment = {
  /** Exactly two distinct-place counted votes came back (anything else cannot be decisive). */
  decisiveVotes: boolean
  /** The rank/judge decision (see decideImproveRound) picked the defender (top first opinion). */
  defenderWon: boolean
  /** The decision had to fall back (no vote, unrankable incumbent, unsure JEV unsettled). */
  unjudged: boolean
  /** A model judge (not JEV) cast a ranking. */
  modelVoted: boolean
  /** JEV said it was unsure. */
  jevUnsure: boolean
  /** When JEV was unsure, whether every pair of candidates still got a model comparison. */
  everyPairJudged: boolean
  /** JEV produced no counted ballot at all (never ran, or its call failed) — never "unsure". */
  jevFailed: boolean
}

export type CouncilFinalCheckOutcome = {
  winner: 'defender' | 'challenger'
  decisive: boolean
  reason: string
  judgedBy: ('jev' | 'models')[]
}

export function decideCouncilFinalCheck(
  judgment: CouncilFinalCheckJudgment
): CouncilFinalCheckOutcome {
  const decisive =
    judgment.decisiveVotes &&
    !judgment.unjudged &&
    !(judgment.jevUnsure && !judgment.everyPairJudged)
  if (!decisive) {
    // Non-decisive keeps the chair: winner must say 'challenger' here, never 'defender', so a
    // consumer that ships purely off `winner` (a future NOUL decider included) never ships the
    // first opinion on a tie. judgedBy is empty: no judge actually decided anything.
    return {
      winner: 'challenger',
      decisive: false,
      reason: judgment.unjudged
        ? "The comparison could not be settled, so the chairman's answer was kept."
        : "The comparison was not decisive, so the chairman's answer was kept.",
      judgedBy: []
    }
  }
  // Credit exactly who actually decided: JEV alone when it was sure and no model was needed,
  // both when JEV was unsure and a model settled it, and models alone when JEV produced no
  // counted ballot at all (never a bare ['jev'] when JEV in fact failed).
  const judgedBy: CouncilFinalCheckOutcome['judgedBy'] = [
    ...(judgment.jevFailed ? [] : (['jev'] as const)),
    ...(judgment.modelVoted ? (['models'] as const) : [])
  ]
  return {
    winner: judgment.defenderWon ? 'defender' : 'challenger',
    decisive: true,
    reason: judgment.defenderWon
      ? 'The best first opinion was judged better.'
      : "The chairman's answer was judged better.",
    judgedBy
  }
}
