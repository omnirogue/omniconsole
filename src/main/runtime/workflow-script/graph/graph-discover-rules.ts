import type { WorkflowSpec } from '../../../../shared/workflow-graph'

export const DISCOVER_VERIFY_RULES = 1
export type GraphDiscoverFields = { discoverVerifyRules?: number }

/** New runs opt in; saved runs retain their recorded verification contracts. */
export function graphDiscoverVerifyAdmission(spec: WorkflowSpec): GraphDiscoverFields {
  return spec.template === 'discover' && spec.steps.some((step) => step.list?.evidence)
    ? { discoverVerifyRules: DISCOVER_VERIFY_RULES }
    : {}
}

export function graphDiscoverVerifyRules(snapshot: object): GraphDiscoverFields {
  const value = (snapshot as { host?: { discoverVerifyRules?: unknown } }).host?.discoverVerifyRules
  if (typeof value === 'number' && value > DISCOVER_VERIFY_RULES) {
    throw new Error(`Unsupported Discover verification rules: ${value}`)
  }
  return typeof value === 'number' ? { discoverVerifyRules: value } : {}
}

export function graphUsesLegacyVerification(scope: {
  config?: GraphDiscoverFields & { spec?: WorkflowSpec }
}): boolean {
  const config = scope.config
  return (
    config?.spec?.template !== 'discover' ||
    (config.discoverVerifyRules ?? 0) < DISCOVER_VERIFY_RULES ||
    !config.spec.steps.some((step) => step.list?.evidence)
  )
}
