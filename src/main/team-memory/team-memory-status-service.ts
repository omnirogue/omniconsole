import type { ConsoleWorkflowResult } from '../../shared/console-workflow-types'
import type { AppHealthReportInput } from '../../shared/app-health-contract'
import {
  teamMemoryReasonForError,
  teamMemoryViewFromStatus,
  type TeamMemoryStatus,
  type TeamMemoryStatusView
} from '../../shared/team-memory-contract'

export const TEAM_MEMORY_POLL_INTERVAL_MS = 30 * 60 * 1000
export const TEAM_MEMORY_STATUS_CHANNEL = 'teamMemory:status'

export type TeamMemoryStatusServiceDeps = {
  isSignedIn: () => boolean
  fetchStatus: () => Promise<ConsoleWorkflowResult<TeamMemoryStatus>>
  reportHealth: (input: AppHealthReportInput) => void
  publish: (status: TeamMemoryStatusView) => void
  now?: () => number
}

/**
 * Whether Sal and Uma's instructions are loaded in this person's connector. Main
 * keeps the answer, refreshes it every 30 minutes and on demand, pushes each change
 * to the renderer, and tells the console (app-health `team_memory`) when it is not.
 */
export class TeamMemoryStatusService {
  private current: TeamMemoryStatusView = { state: 'unknown' }
  private timer: NodeJS.Timeout | null = null
  private inFlight: Promise<TeamMemoryStatusView> | null = null
  private readonly now: () => number

  constructor(private readonly deps: TeamMemoryStatusServiceDeps) {
    this.now = deps.now ?? Date.now
  }

  status(): TeamMemoryStatusView {
    return this.current
  }

  start(): void {
    if (this.timer) {
      return
    }
    void this.refresh()
    this.timer = setInterval(() => void this.refresh(), TEAM_MEMORY_POLL_INTERVAL_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  refresh(): Promise<TeamMemoryStatusView> {
    if (this.inFlight) {
      return this.inFlight
    }
    this.inFlight = this.check().finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  private async check(): Promise<TeamMemoryStatusView> {
    const checkedAt = this.now()
    let next: TeamMemoryStatusView
    if (!this.deps.isSignedIn()) {
      next = { state: 'not_loaded', reason: 'not_signed_in', checkedAt }
    } else {
      const result = await this.deps
        .fetchStatus()
        .catch((): ConsoleWorkflowResult<TeamMemoryStatus> => ({
          ok: false,
          error: { code: 'backoffice_unavailable', message: 'The status request failed.' }
        }))
      next = result.ok
        ? teamMemoryViewFromStatus(result.data, checkedAt)
        : { state: 'not_loaded', reason: teamMemoryReasonForError(result.error.code), checkedAt }
      if (next.state === 'loaded') {
        this.deps.reportHealth({
          feature: 'team_memory',
          status: 'ok',
          ...(next.indexOverBudget ? { code: 'index_over_budget' } : {}),
          message: `everyone r${next.everyoneRevision ?? '-'} personal r${next.personalRevision ?? '-'}`
        })
      } else if (next.state === 'not_loaded') {
        this.deps.reportHealth({ feature: 'team_memory', status: 'error', code: next.reason })
      }
    }
    this.current = next
    this.deps.publish(next)
    return next
  }
}
