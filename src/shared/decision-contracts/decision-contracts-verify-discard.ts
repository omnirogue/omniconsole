import {
  JEV_VERIFY_CONFIRM_RANGE,
  JEV_VERIFY_REJECT_AT,
  JEV_VERIFY_REJECT_RANGE
} from '../jev-confidence'
import type { DecisionContract } from './decision-contract-types'
import { findingVerify } from './decision-contracts-gates'

// Version 3 (2026-09-28, JEV Lab Experiments 5-6) discards by default: p <= 0.1 was never a real
// bug, p >= 0.9 matched one only 51-79% of the time. Runs frozen under @2 keep @2's rule.
const findingVerifyDiscard = {
  ...findingVerify,
  version: 3,
  gates: [
    findingVerify.gates[0],
    {
      id: 'set-aside',
      by: 'rule',
      means: `Live: after the reviewers' verdicts, an item they left unverified is set aside by JEV (refuted, marked as JEV's, with its probability) when its probability is at or below the step's rejectAt (${JEV_VERIFY_REJECT_RANGE[0]}–${JEV_VERIFY_REJECT_RANGE[1]}; ${JEV_VERIFY_REJECT_AT} when the step sets neither rejectAt nor confirmAt, none when it sets only confirmAt). A finding merged from several reports is set aside only when every report JEV judged is at or below it. A later report of it that JEV never saw puts it back to unverified.`
    },
    {
      id: 'confirm',
      by: 'rule',
      means: `Only when the step sets confirmAt (${JEV_VERIFY_CONFIRM_RANGE[0]}–${JEV_VERIFY_CONFIRM_RANGE[1]}, above rejectAt): an item they left unverified at or above it (every report JEV judged, for a merged finding) is confirmed by JEV and marked so, unless a page backs it with no quote the app found. Without it JEV never confirms. The thresholds applied are the ones in the recorded JEV request.`
    },
    {
      id: 'never-against',
      by: 'rule',
      means:
        "JEV never changes a reviewer's confirmed or refuted verdict; a failed or missing probability changes nothing and is never a no."
    }
  ],
  // Setting aside a real finding is now the costly mistake.
  harm: 'false-no'
} as const satisfies Omit<DecisionContract, 'id' | 'serves'>

export const DISCOVER_VERIFY_DISCARD: DecisionContract = {
  ...findingVerifyDiscard,
  id: 'discover-verify',
  serves:
    "Discover (live, uncalibrated): settle what reviewers left unverified by JEV's probability, at the step's thresholds; with none set, only set aside what JEV finds not real."
}

export const GENERIC_FINDING_VERIFY_DISCARD: DecisionContract = {
  ...findingVerifyDiscard,
  id: 'generic-finding-verify',
  serves:
    "Any review of each item (live, uncalibrated): settle what reviewers left unverified by JEV's probability, at the step's thresholds; with none set, only set aside what JEV finds not real."
}

export const VERIFY_DISCARD_CONTRACTS: readonly DecisionContract[] = [
  DISCOVER_VERIFY_DISCARD,
  GENERIC_FINDING_VERIFY_DISCARD
]
