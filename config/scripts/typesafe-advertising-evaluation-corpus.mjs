// Frozen labels were authored before live calls; synthetic policy agreement is not production profitability.
import { AD_SIBLING_CASES } from './typesafe-advertising-sibling-cases.mjs'
import { AD_CREATIVE_CASES } from './typesafe-advertising-creative-cases.mjs'
import { AD_RECOMMENDATION_AUDIT_CASES } from './typesafe-advertising-audit-cases.mjs'

export { AD_SIBLING_SIMULATION_POLICY } from './typesafe-advertising-sibling-cases.mjs'
export const ADVERTISING_EVALUATION_CASES = Object.freeze(
  [...AD_SIBLING_CASES, ...AD_CREATIVE_CASES, ...AD_RECOMMENDATION_AUDIT_CASES].map((item) =>
    Object.freeze({ ...item, expected: Object.freeze(item.expected) })
  )
)
