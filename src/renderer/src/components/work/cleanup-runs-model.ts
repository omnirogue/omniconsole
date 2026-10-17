import type { AutomationRunStatus } from '../../../../shared/automations-types'
import type { CleanupAdmission, CleanupRunSource } from '../../../../shared/session-cleanup-run'
import { translate } from '@/i18n/i18n'

export type CleanupRunPhase = 'starting' | 'running' | 'finished' | 'failed' | 'not-started'

export function cleanupRunPhase(status: AutomationRunStatus): CleanupRunPhase {
  switch (status) {
    case 'pending':
    case 'dispatching':
      return 'starting'
    case 'dispatched':
      return 'running'
    case 'completed':
      return 'finished'
    case 'dispatch_failed':
      return 'failed'
    case 'skipped_precheck':
    case 'skipped_missed':
    case 'skipped_unavailable':
    case 'skipped_needs_interactive_auth':
      return 'not-started'
  }
}

export function cleanupPhaseLabel(phase: CleanupRunPhase): string {
  switch (phase) {
    case 'starting':
      return translate('work.cleanup.phase.starting', 'starting')
    case 'running':
      return translate('work.cleanup.phase.running', 'running')
    case 'finished':
      return translate('work.cleanup.phase.finished', 'finished')
    case 'failed':
      return translate('work.cleanup.phase.failed', 'failed')
    case 'not-started':
      return translate('work.cleanup.phase.notStarted', 'did not start')
  }
}

export function cleanupSourceLabel(source: CleanupRunSource): string {
  return source === 'automatic'
    ? translate('work.cleanup.automatic', 'Automatic')
    : translate('work.cleanup.manual', 'Clean up now')
}

export function cleanupClock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** What the person sees after pressing Clean up now. */
export function cleanupNowOutcome(admission: CleanupAdmission): {
  tone: 'success' | 'warning'
  message: string
} {
  if (admission.ok) {
    return {
      tone: 'success',
      message: translate(
        'work.cleanup.started',
        'A cleanup session is starting; it closes itself when it has reported.'
      )
    }
  }
  return { tone: 'warning', message: admission.detail }
}
