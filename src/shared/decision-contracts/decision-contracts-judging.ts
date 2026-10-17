import { JEV_AUTO_PAIRWISE_MAX, JEV_SCORE_MARGIN, JEV_UNSURE_BAND } from '../jev-confidence'
import {
  GATE_TARGET,
  RANKING_TARGET,
  type ConfidencePolicy,
  type DecisionContract
} from './decision-contract-types'

// Version 1 of each contract states today's behaviour exactly; any change is a new version.

const AUTO: ConfidencePolicy = {
  method: 'auto',
  pairwiseUpTo: JEV_AUTO_PAIRWISE_MAX,
  scoreMargin: JEV_SCORE_MARGIN,
  pairBand: JEV_UNSURE_BAND
}

const JEV_FIRST_GATE = {
  id: 'jev-first',
  by: 'jev',
  means:
    "JEV ranks alone when it is sure; the step's model judges rank only when it is unsure or could not judge."
} as const

const BALLOT_EVIDENCE = [
  'the task',
  'every answer, labelled and shown blind',
  "the step's instruction as the rubric, or JEV's default rubric when it is empty"
] as const

const rankBallot = {
  version: 1,
  kind: 'rank-ballot',
  evidence: BALLOT_EVIDENCE,
  gates: [JEV_FIRST_GATE],
  criteria: { from: 'step-instruction' },
  unknown: { when: ['jev-failed', 'unsure'], fallback: 'models-decide' },
  confidence: AUTO,
  harm: 'symmetric',
  target: RANKING_TARGET
} as const satisfies Omit<DecisionContract, 'id' | 'serves'>

export const COUNCIL_PEER_RANK: DecisionContract = {
  ...rankBallot,
  id: 'council-peer-rank',
  serves: 'Council: order the first opinions so the chairman builds on the best.'
}

export const IMPROVE_JUDGE: DecisionContract = {
  ...rankBallot,
  id: 'improve-judge',
  serves: 'Improve: decide whether a challenger replaces the best version so far.',
  gates: [
    {
      id: 'check',
      by: 'rule',
      means:
        "When the person set an objective check, passing it and a higher score outrank any judge's opinion."
    },
    JEV_FIRST_GATE,
    {
      id: 'incumbent',
      by: 'rule',
      means:
        'A tie, no counted vote, or an unsure JEV no model judge settled keeps the best version.'
    }
  ],
  unknown: { when: ['jev-failed', 'unsure', 'no-counted-vote'], fallback: 'keep-incumbent' }
}

export const FIND_FINAL: DecisionContract = {
  ...rankBallot,
  id: 'find-final',
  serves: "Find the best: pick the winner among the screen's finalists, head to head.",
  gates: [
    {
      id: 'check',
      by: 'rule',
      means: "Complete versions: a person's objective check runs first and outranks any judge."
    },
    JEV_FIRST_GATE,
    {
      id: 'screen-order',
      by: 'rule',
      means:
        'With no counted vote the top-screened finalist wins; a tie goes to the higher screen score, then the pool order.'
    }
  ]
}

export const GENERIC_RANK_BALLOT: DecisionContract = {
  ...rankBallot,
  id: 'generic-rank-ballot',
  serves: 'Any Rank step with JEV: order the answers it reads.',
  gates: [
    {
      id: 'jev-ballot',
      by: 'jev',
      means:
        "JEV casts one ballot; with JEV first, the step's model judges rank only when it is unsure or could not judge."
    }
  ]
}

const criterionLine = {
  version: 1,
  kind: 'criterion-line',
  evidence: [
    'the task',
    'every developed option, labelled and shown blind',
    "one line of the rubric in the step's rubricFrom answer"
  ],
  gates: [
    {
      id: 'both-orders',
      by: 'jev',
      means:
        'JEV judges the line in both orders and is unsure inside the band or when its order flips; then the model judges rank it, also in both orders.'
    },
    {
      id: 'unsettled',
      by: 'rule',
      means:
        'A line no one settled in both orders is left out of the overall order and reported as a gap.'
    }
  ],
  criteria: { from: 'rubric-from-step' },
  unknown: { when: ['jev-failed', 'unsure', 'no-counted-vote'], fallback: 'gap' },
  confidence: { method: 'pairwise', pairBand: JEV_UNSURE_BAND },
  harm: 'symmetric',
  target: RANKING_TARGET
} as const satisfies Omit<DecisionContract, 'id' | 'serves'>

export const DECIDE_COMPARE_LINE: DecisionContract = {
  ...criterionLine,
  id: 'decide-compare-line',
  serves: "Decide: order the finalists on one line of the frame's rubric."
}

export const GENERIC_CRITERION_LINE: DecisionContract = {
  ...criterionLine,
  id: 'generic-criterion-line',
  serves: 'Any comparison by criterion: order its answers on one rubric line.'
}

const finalCheck = {
  version: 1,
  kind: 'final-check',
  evidence: [
    'the task',
    'the best first answer and the final answer, labelled and shown blind',
    "the rank step's instruction as the rubric, or JEV's default rubric when it is empty"
  ],
  gates: [
    {
      id: 'jev-first',
      by: 'jev',
      means:
        "JEV compares the two answers; the rank step's model judges vote only when it is unsure or could not judge."
    },
    {
      id: 'decisive',
      by: 'rule',
      means:
        'Only two counted votes in distinct places decide; anything else keeps the final answer.'
    }
  ],
  criteria: { from: 'step-instruction' },
  unknown: { when: ['jev-failed', 'unsure', 'no-counted-vote'], fallback: 'keep-chair' },
  confidence: AUTO,
  // A wrong "the first answer is better" replaces the final answer, so that is the costly side.
  harm: 'false-yes',
  target: GATE_TARGET
} as const satisfies Omit<DecisionContract, 'id' | 'serves'>

export const COUNCIL_FINAL_CHECK: DecisionContract = {
  ...finalCheck,
  id: 'council-final-check',
  serves: "Council: keep the chairman's answer unless the best first opinion is judged better."
}

export const DECIDE_FINAL_CHECK: DecisionContract = {
  ...finalCheck,
  id: 'decide-final-check',
  serves: 'Decide: keep the memo unless the best finalist is judged better.',
  evidence: [
    'the question',
    'the best finalist and the memo, labelled and shown blind',
    "the Compare step's instruction as the rubric: empty in the template, so JEV's default rubric, not the frame's"
  ]
}

export const GENERIC_FINAL_CHECK: DecisionContract = {
  ...finalCheck,
  id: 'generic-final-check',
  serves: 'Any final check: keep the final answer unless the best ranked answer is judged better.'
}

export const JUDGING_CONTRACTS: readonly DecisionContract[] = [
  COUNCIL_PEER_RANK,
  IMPROVE_JUDGE,
  FIND_FINAL,
  GENERIC_RANK_BALLOT,
  DECIDE_COMPARE_LINE,
  GENERIC_CRITERION_LINE,
  COUNCIL_FINAL_CHECK,
  DECIDE_FINAL_CHECK,
  GENERIC_FINAL_CHECK
]
