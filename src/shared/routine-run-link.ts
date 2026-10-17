import { normalizeExecutionHostId } from './execution-host'
export type RoutineRunLink = { automationId: string; runId: string; hostId: string }
export function buildRoutineRunLink(input: RoutineRunLink): string {
  return `omni://automation/${encodeURIComponent(input.automationId)}/run/${encodeURIComponent(input.runId)}?hostId=${encodeURIComponent(input.hostId)}`
}
export function parseRoutineRunLink(value: string): RoutineRunLink | null {
  try {
    const url = new URL(value)
    if (!['omni:', 'orca:'].includes(url.protocol) || url.hostname !== 'automation') {
      return null
    }
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    const hostId = normalizeExecutionHostId(url.searchParams.get('hostId') ?? 'local')
    if (
      parts.length !== 3 ||
      parts[1] !== 'run' ||
      !hostId ||
      [parts[0], parts[2]].some((id) => !/^[a-zA-Z0-9_-]{1,128}$/.test(id))
    ) {
      return null
    }
    return { automationId: parts[0], runId: parts[2], hostId }
  } catch {
    return null
  }
}
