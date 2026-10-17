import { parseExecutionHostId, type ParsedExecutionHost } from './execution-host'
import type { ProjectHostPolicy } from './project-settings'

/**
 * The project's Computers setting as a run target (upgrade plan PR 4). A named list is an order
 * of preference: the first computer the caller can use wins, and the ones passed over are kept
 * so the caller can say why. `auto` and `as-named` choose nothing, so launches stay as they were.
 */
export type ProjectHostPick = {
  host: ParsedExecutionHost | null
  passedOver: ParsedExecutionHost[]
}

/** The listed computers in order; an entry this build cannot read is left out. */
export function projectHostsInOrder(policy: ProjectHostPolicy | undefined): ParsedExecutionHost[] {
  if (!Array.isArray(policy)) {
    return []
  }
  const seen = new Set<string>()
  const hosts: ParsedExecutionHost[] = []
  for (const entry of policy) {
    const host = parseExecutionHostId(entry)
    if (host && !seen.has(host.id)) {
      seen.add(host.id)
      hosts.push(host)
    }
  }
  return hosts
}

export function pickProjectHost(
  policy: ProjectHostPolicy | undefined,
  usable: (host: ParsedExecutionHost) => boolean
): ProjectHostPick {
  const passedOver: ParsedExecutionHost[] = []
  for (const host of projectHostsInOrder(policy)) {
    if (usable(host)) {
      return { host, passedOver }
    }
    passedOver.push(host)
  }
  return { host: null, passedOver }
}
