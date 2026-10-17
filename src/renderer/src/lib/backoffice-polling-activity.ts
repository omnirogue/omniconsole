import { BACKOFFICE_POLLING } from '../../../shared/backoffice-polling-cadence'
let lastActivity: number | null = null

export function noteBackofficeActivity(): void {
  lastActivity = Date.now()
}
export function isBackofficePollingIdle(): boolean {
  lastActivity ??= Date.now()
  return Date.now() - lastActivity >= BACKOFFICE_POLLING.idleStopMs
}
