import { isStablePaneId, parsePaneKey } from './stable-pane-id'

export function isLaunchUuid(value: unknown): value is string {
  return typeof value === 'string' && isStablePaneId(value)
}
export function isLaunchPaneKey(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false
  }
  const parsed = parsePaneKey(value)
  return parsed !== null && isLaunchUuid(parsed.tabId)
}
export function isLaunchTerminalHandle(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('term_') && isLaunchUuid(value.slice(5))
}
export function isLaunchRequestId(value: unknown): value is string {
  return (
    isLaunchUuid(value) ||
    (typeof value === 'string' &&
      (/^\d{13}-[0-9a-f]{32}$/.test(value) ||
        (/^(?:session-prep|session-manage|build-review):[0-9a-f-]{36}$/.test(value) &&
          isLaunchUuid(value.split(':')[1]))))
  )
}
const generated = (value: unknown, prefix: string): value is string =>
  typeof value === 'string' && new RegExp(`^${prefix}_[0-9a-f]{12}$`).test(value)

// Formats come from automation persistence, orchestration generated-id, session-prep-ids and recovery preparation.
export function isLaunchReferenceId(key: string, value: unknown): value is string {
  switch (key) {
    case 'orchestrationTaskId':
      return generated(value, 'task')
    case 'orchestrationDispatchId':
      return generated(value, 'ctx')
    case 'orchestrationRunId':
      return generated(value, 'run')
    case 'outcomeChainId':
      return isLaunchUuid(value) || generated(value, 'chn')
    case 'workflowRunId':
      return isLaunchUuid(value) || generated(value, 'run') || generated(value, 'lrn')
    case 'buildReviewRunId':
      return generated(value, 'brp') || generated(value, 'lrn')
    case 'consoleJobId':
      return (
        isLaunchUuid(value) || (typeof value === 'string' && /^job_[a-z0-9]{8,40}$/.test(value))
      )
    case 'sessionPrepBatchId':
      return typeof value === 'string' && /^sp_[0-9a-z]{7,20}$/.test(value)
    case 'agentSessionId':
      return (
        isLaunchUuid(value) ||
        (typeof value === 'string' &&
          /^(?:claude|codex)_/.test(value) &&
          isLaunchUuid(value.replace(/^(?:claude|codex)_/, '').replaceAll('_', '-')))
      )
    case 'recoveryId':
      return typeof value === 'string' && /^capacity-recovery:[0-9a-f]{64}$/.test(value)
    default:
      return isLaunchUuid(value)
  }
}
