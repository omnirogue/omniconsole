import { translate as t } from '@/i18n/i18n'
import type { UpNextBlockState, UpNextHeader } from '../../../../shared/up-next-types'

/**
 * One plain sentence per failure code (`session-attempt-recovery.ts`, `session-outcome-block.ts`).
 * The host's raw diagnostic is never the headline: it stays under Details.
 */
const FAILURE_LABELS: Record<string, string> = {
  'launch-not-started': 'The agent could not be started',
  'worker-stalled': 'The agent stopped responding',
  'worker-exited': 'The agent exited before it finished',
  'agent-turn-failed': 'The agent’s turn failed',
  'startup-blocked': 'The agent could not get past its startup',
  'prompt-not-accepted': 'The agent did not accept the instruction',
  'provider-usage-limit': 'The provider’s usage limit was reached',
  'provider-authentication': 'The provider rejected the sign-in',
  'operator-closed': 'The agent was closed before it finished',
  'brief-too-large': 'The instruction was too large for the agent',
  'unverifiable-worker': 'The agent could not be confirmed stopped, so it was not restarted',
  'handoff-hold': 'The handoff could not be delivered',
  'review-round-hold': 'The review round did not finish',
  'verification-hold': 'The result could not be verified',
  'continuation-held': 'The work queued after the review was not started',
  'continuation-refused': 'The work queued after the review could not be started',
  'review-fix-failed': 'The reviewer’s notes could not be given to the agent'
}

export function failureLabel(code: string | undefined): string {
  const known = code ? FAILURE_LABELS[code] : undefined
  return known
    ? t(`upNext.failure.${code}`, known)
    : t('upNext.failure.other', 'Automatic recovery could not continue')
}

/** "in 40s", "in 3 min": when the host next acts, against the clock the caller read. */
export function untilLabel(at: number, now: number): string {
  const seconds = Math.round((at - now) / 1000)
  if (seconds <= 0) {
    return t('upNext.dueNow', 'now')
  }
  return seconds < 60
    ? t('upNext.inSeconds', 'in {{seconds}}s', { seconds })
    : t('upNext.inMinutes', 'in {{minutes}} min', { minutes: Math.round(seconds / 60) })
}

/** The wake a `waiting` run names; the policy's own generic words are said in the UI's language. */
export function wakeLabel(wake: string | undefined): string {
  if (!wake || wake === 'evidence') {
    return t('upNext.wake.evidence', 'verified evidence')
  }
  return wake === 'execution host' ? t('upNext.wake.host', 'the execution host') : wake
}

/** The header's one line for a run that stopped before it finished. Never the diagnostic. */
export function stoppedHeaderLine(header: UpNextHeader, now: number): string {
  if (header.state === 'recovering') {
    return header.recoveringUntil === undefined
      ? t('upNext.recovering', 'Recovering automatically')
      : t('upNext.recoveringUntil', 'Recovering automatically · next attempt {{when}}', {
          when: untilLabel(header.recoveringUntil, now)
        })
  }
  if (header.state === 'waiting') {
    return t('upNext.waitingFor', 'Waiting for {{wake}}', { wake: wakeLabel(header.wake) })
  }
  return header.state === 'failed'
    ? t('upNext.failedHeader', 'Failed · {{summary}}', {
        summary: failureLabel(header.failure?.code)
      })
    : ''
}

/**
 * A stopped stage's own line, in the open row. The header already said "Failed ·" once and the
 * row's tag says `failed`, so a failed stage states only WHAT failed, in plain words.
 */
export function stoppedStageLine(state: UpNextBlockState, code: string | undefined): string {
  if (state === 'recovering') {
    return t('upNext.stageRecovering', 'Recovering automatically — nothing to do here.')
  }
  if (state === 'waiting') {
    return t('upNext.stageWaiting', 'Waiting — the run continues by itself.')
  }
  if (state === 'needs-you') {
    return t('upNext.stageNeedsYou', 'Waiting for your answer — see the request above.')
  }
  return state === 'failed' ? failureLabel(code) : ''
}
