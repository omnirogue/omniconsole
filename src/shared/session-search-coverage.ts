import type { SessionSearchHostStatus } from './session-search-types'

export function sessionSearchCoverageIncomplete(
  hosts: readonly SessionSearchHostStatus[]
): boolean {
  return (
    hosts.length === 0 ||
    hosts.some((host) => host.state !== 'searched' || (host.pendingFiles ?? 0) > 0)
  )
}
