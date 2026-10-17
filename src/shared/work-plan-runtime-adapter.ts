import type { SessionChainAgentStep } from './session-chain-types'

// WP-5 owns admission of the failure route; persistence has no carrier yet.
export type WorkPlanRuntimeStep = SessionChainAgentStep & { onFail?: string }
