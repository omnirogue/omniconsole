import { graphDiscoverVerifyRules } from './graph-discover-rules'
import { graphDecisionRules } from './graph-decision-rules'
import { graphImproveRules } from './graph-improve-rules'
import { graphImproveFrontierSeats } from './graph-improve-frontier'
import { graphFindRules } from './graph-plan-types'
import { graphEvidenceRules } from './graph-pre-verify'
import { graphWebRules } from './graph-web-types'
import { graphEarlierHold } from '../workflow-earlier-findings'

/** The rule revisions a run's snapshot pins; the runner and the projection must read the same set. */
export function graphSnapshotRules(snapshot: object) {
  return {
    ...graphImproveRules(snapshot),
    ...graphImproveFrontierSeats(snapshot),
    ...graphFindRules(snapshot),
    ...graphWebRules(snapshot),
    ...graphDecisionRules(snapshot),
    ...graphEvidenceRules(snapshot),
    ...graphDiscoverVerifyRules(snapshot),
    ...graphEarlierHold(snapshot)
  }
}
