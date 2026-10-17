import {
  JEV_VERIFY_BAND,
  JEV_VERIFY_CONFIRM_AT,
  JEV_VERIFY_CONFIRM_RANGE,
  JEV_VERIFY_QUESTION,
  ONE_ANSWER_QUESTION
} from '../jev-confidence'
import { WORKFLOW_MAX_RANK_CANDIDATES, WORKFLOW_SCREEN_SET_ASIDE } from '../workflow-graph'
import { ONE_ANSWER_UNSURE_BAND } from '../workflow-one-answer'
import { GATE_TARGET, type DecisionContract } from './decision-contract-types'

// Version 1 of each contract states today's behaviour exactly; any change is a new version.

const screenOrder = {
  version: 1,
  kind: 'screen-order',
  evidence: [
    'the task',
    'every option, in pages under Find rules 3',
    "the judge step's instruction as the rubric, or JEV's default rubric when it is empty"
  ],
  gates: [
    {
      id: 'scores',
      by: 'jev',
      means: 'JEV scores every option 0–4, overall and on each rubric line.'
    },
    {
      id: 'finalists',
      by: 'rule',
      means:
        "The best-scored options reach the final, and under Find rules 3 each line's leaders too; when all fit in the final, there is no screen."
    },
    {
      id: 'unscored',
      by: 'rule',
      means: 'An option JEV could not score does not reach the final and is counted as unscored.'
    }
  ],
  criteria: { from: 'step-instruction' },
  unknown: { when: ['jev-failed'], fallback: 'gap' },
  confidence: { method: 'scores' },
  // Leaving the best option out of the final is the costly mistake.
  harm: 'false-no',
  target: GATE_TARGET
} as const satisfies Omit<DecisionContract, 'id' | 'serves'>

export const FIND_SCREEN: DecisionContract = {
  ...screenOrder,
  id: 'find-screen',
  serves: 'Find the best: score every option so the best few meet in the final.'
}

export const GENERIC_SCREEN_ORDER: DecisionContract = {
  ...screenOrder,
  id: 'generic-screen-order',
  serves: 'Any Find the best: score every option so the best few meet in the final.'
}

// Version 2 changes only what an unscored option means: @1 left it out of the final, as if low.
const screenOrderV2 = {
  ...screenOrder,
  version: 2,
  gates: [
    screenOrder.gates[0],
    screenOrder.gates[1],
    {
      id: 'unscored',
      by: 'rule',
      means: `An option JEV could not score is never read as low: it joins the final unscored while the final holds fewer than ${WORKFLOW_MAX_RANK_CANDIDATES}, every one is named with the reason, and any the final had no room for are a gap. In a tie in the final it has no screen score, so the pool order decides.`
    },
    {
      id: 'screen-failed',
      by: 'rule',
      means: 'A screen JEV could not give at all stops the run with the reason; Retry asks again.'
    }
  ],
  unknown: { when: ['unscored'], fallback: 'keep-and-verify' }
} as const satisfies Omit<DecisionContract, 'id' | 'serves'>

export const FIND_SCREEN_V2: DecisionContract = {
  ...screenOrderV2,
  id: 'find-screen',
  serves: FIND_SCREEN.serves
}

export const GENERIC_SCREEN_ORDER_V2: DecisionContract = {
  ...screenOrderV2,
  id: 'generic-screen-order',
  serves: GENERIC_SCREEN_ORDER.serves
}

const setAside = {
  version: 1,
  kind: 'set-aside-gate',
  evidence: [
    'the goal',
    'one item: its title, location, severity and detail',
    "the screen's rubric, the ## Rubric of its rubricFrom answer, or the default screen rubric"
  ],
  gates: [
    { id: 'screen', by: 'jev', means: 'JEV scores each item 0–4 against the rubric.' },
    {
      id: 'set-aside',
      by: 'rule',
      means:
        'An item scored below the line and reported only once is set aside unchecked; reported more than once, it stays.'
    },
    {
      id: 'unscored',
      by: 'rule',
      means:
        'An item JEV could not score counts as 2 of 4; a failed screen sends every item on by severity.'
    }
  ],
  criteria: { from: 'rubric-from-step' },
  unknown: { when: ['jev-failed', 'unscored'], fallback: 'keep-and-verify' },
  confidence: { method: 'score-line', below: WORKFLOW_SCREEN_SET_ASIDE },
  // Setting aside a real item unchecked is the costly mistake.
  harm: 'false-yes',
  target: GATE_TARGET
} as const satisfies Omit<DecisionContract, 'id' | 'serves'>

export const DISCOVER_SET_ASIDE: DecisionContract = {
  ...setAside,
  id: 'discover-set-aside',
  serves: 'Discover: set aside findings that are not real before any reviewer reads them.'
}

export const GENERIC_SET_ASIDE_GATE: DecisionContract = {
  ...setAside,
  id: 'generic-set-aside-gate',
  serves: 'Any screened review: set aside items that are not real before any reviewer reads them.'
}

const hardLimit = {
  version: 1,
  kind: 'hard-limit-gate',
  evidence: [
    'the task',
    'every option',
    "the hard limits and rubric lines of the step's rubricFrom answer, or the default option rubric"
  ],
  gates: [
    {
      id: 'hard-limit',
      by: 'jev',
      means: 'An option JEV scores below the line on any hard limit is dropped.'
    },
    {
      id: 'shortlist',
      by: 'rule',
      means:
        "Of the rest: the best overall, every option not scored in full, each line's leader and one wildcard, then the next best, up to the limit."
    },
    {
      id: 'unfitted',
      by: 'rule',
      means:
        "Hard limits that do not fit JEV's screen, and unscored options left over, are reported as a gap."
    }
  ],
  criteria: { from: 'rubric-from-step' },
  unknown: { when: ['jev-failed', 'unscored'], fallback: 'keep-and-verify' },
  confidence: { method: 'score-line', below: WORKFLOW_SCREEN_SET_ASIDE },
  // Dropping an option that keeps every limit is the costly mistake.
  harm: 'false-yes',
  target: GATE_TARGET
} as const satisfies Omit<DecisionContract, 'id' | 'serves'>

export const DECIDE_SHORTLIST: DecisionContract = {
  ...hardLimit,
  id: 'decide-shortlist',
  serves: "Decide: drop options that break the frame's hard limits, then keep a varied shortlist."
}

export const GENERIC_HARD_LIMIT_GATE: DecisionContract = {
  ...hardLimit,
  id: 'generic-hard-limit-gate',
  serves: 'Any shortlist: drop options that break a hard limit, then keep a varied shortlist.'
}

const oneAnswer = {
  version: 1,
  kind: 'one-answer-route',
  evidence: ["the person's question"],
  gates: [
    {
      id: 'route',
      by: 'jev',
      means:
        'Only a probability above the band sends the question to one model; inside the band, below it, or with no reading, the full workflow runs.'
    }
  ],
  criteria: { from: 'fixed', lines: [ONE_ANSWER_QUESTION] },
  unknown: { when: ['jev-failed', 'unsure'], fallback: 'full-workflow' },
  confidence: { method: 'noul', question: ONE_ANSWER_QUESTION, band: ONE_ANSWER_UNSURE_BAND },
  // Sending a judgement question to one model alone is the costly mistake.
  harm: 'false-yes',
  target: GATE_TARGET
} as const satisfies Omit<DecisionContract, 'id' | 'serves'>

export const DECIDE_ONE_ANSWER: DecisionContract = {
  ...oneAnswer,
  id: 'decide-one-answer',
  serves: 'Decide: send a question with one checkable right answer to one model alone.'
}

export const GENERIC_ONE_ANSWER_ROUTE: DecisionContract = {
  ...oneAnswer,
  id: 'generic-one-answer-route',
  serves: 'Any one-answer route: send a question with one checkable right answer to one model.'
}

export const findingVerify = {
  version: 1,
  kind: 'finding-verify',
  evidence: [
    'the goal and the scope the brief gives',
    "one item: its title, location and detail, and the file's lines around the cited line"
  ],
  gates: [
    {
      id: 'verify',
      by: 'jev',
      means: 'JEV gives the probability that the item is a real, in-scope defect.'
    },
    {
      id: 'shadow',
      by: 'rule',
      means:
        'Shadow only: the probability is recorded on the item and decides nothing; the reviewers verify every item as before. Live (a probability of 0.9 or more confirming without reviewers) is not run.'
    }
  ],
  criteria: { from: 'fixed', lines: [JEV_VERIFY_QUESTION] },
  unknown: { when: ['jev-failed', 'too-long'], fallback: 'keep-and-verify' },
  confidence: { method: 'noul', question: JEV_VERIFY_QUESTION, band: JEV_VERIFY_BAND },
  // Confirming a finding that is not real is the costly mistake.
  harm: 'false-yes',
  target: GATE_TARGET
} as const satisfies Omit<DecisionContract, 'id' | 'serves'>

export const DISCOVER_VERIFY: DecisionContract = {
  ...findingVerify,
  id: 'discover-verify',
  serves: 'Discover (shadow, uncalibrated): record how likely JEV finds each finding real.'
}

export const GENERIC_FINDING_VERIFY: DecisionContract = {
  ...findingVerify,
  id: 'generic-finding-verify',
  serves: 'Any review of each item (shadow, uncalibrated): record how likely each item is real.'
}

// Version 2 is live JEV verify (`jevVerify.mode: 'live'`); shadow runs stay on version 1.
// Version 3, discard-only, is in decision-contracts-verify-discard.ts.
const findingVerifyLive = {
  ...findingVerify,
  version: 2,
  gates: [
    findingVerify.gates[0],
    {
      id: 'confirm',
      by: 'rule',
      means: `Live: after the reviewers' verdicts, an item they left unverified is confirmed by JEV when its probability is at or above the step's confirmAt (${JEV_VERIFY_CONFIRM_AT} unless set, ${JEV_VERIFY_CONFIRM_RANGE[0]}–${JEV_VERIFY_CONFIRM_RANGE[1]}), and marked confirmed by JEV with it. An item a page backs with no quote the app found stays unverified.`
    },
    {
      id: 'never-against',
      by: 'rule',
      means:
        "JEV never changes a reviewer's confirmed or refuted verdict, never refutes and never sets an item aside; a promotion is not a new finding for the loop."
    }
  ]
} as const satisfies Omit<DecisionContract, 'id' | 'serves'>

export const DISCOVER_VERIFY_LIVE: DecisionContract = {
  ...findingVerifyLive,
  id: 'discover-verify',
  serves:
    'Discover (live, uncalibrated): confirm the findings reviewers left unverified that JEV finds real.'
}

export const GENERIC_FINDING_VERIFY_LIVE: DecisionContract = {
  ...findingVerifyLive,
  id: 'generic-finding-verify',
  serves:
    'Any review of each item (live, uncalibrated): confirm what reviewers left unverified that JEV finds real.'
}

export const GATE_CONTRACTS: readonly DecisionContract[] = [
  FIND_SCREEN,
  GENERIC_SCREEN_ORDER,
  FIND_SCREEN_V2,
  GENERIC_SCREEN_ORDER_V2,
  DISCOVER_SET_ASIDE,
  GENERIC_SET_ASIDE_GATE,
  DECIDE_SHORTLIST,
  GENERIC_HARD_LIMIT_GATE,
  DECIDE_ONE_ANSWER,
  GENERIC_ONE_ANSWER_ROUTE,
  DISCOVER_VERIFY,
  GENERIC_FINDING_VERIFY,
  DISCOVER_VERIFY_LIVE,
  GENERIC_FINDING_VERIFY_LIVE
]
