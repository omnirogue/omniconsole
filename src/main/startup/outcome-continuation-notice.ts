import { Notification } from 'electron'
import { translateMain } from '../i18n/main-i18n'

export type OutcomeContinuationNotice = { title: string; body: string }

/** Copy for the post-quit background continuation; null when nothing is left to finish. */
export function outcomeContinuationNotice(
  pendingOutcomes: number,
  reviewWaits = 0
): OutcomeContinuationNotice | null {
  if (pendingOutcomes < 1 && reviewWaits < 1) {
    return null
  }
  return {
    title: translateMain('outcomes.continuationNotice.title', 'OmniConsole is still running'),
    body:
      pendingOutcomes > 0
        ? translateMain(
            'outcomes.continuationNotice.body',
            'Unfinished outcomes are continuing in the background. Open OmniConsole to see them.'
          )
        : translateMain(
            'outcomes.continuationNotice.reviewBody',
            'Sessions waiting for a review decision are still watched, so a decision wakes them. Open OmniConsole to see them.'
          )
  }
}

/**
 * Why: quitting the desktop leaves a window-less process finishing outcomes. An invisible survivor the
 * user never agreed to is the defect — not the continuation itself — so say it out loud on both
 * channels: stderr for whoever reads logs, a banner for the person who just pressed Quit.
 */
export function announceOutcomeContinuation(pendingOutcomes: number, reviewWaits = 0): boolean {
  console.warn(
    `[outcomes] Running in the background to finish work left by a desktop quit; pending=${pendingOutcomes} reviewWaits=${reviewWaits}`
  )
  const notice = outcomeContinuationNotice(pendingOutcomes, reviewWaits)
  if (!notice || !Notification.isSupported()) {
    return false
  }
  try {
    new Notification(notice).show()
    return true
  } catch {
    // Best-effort: a failed banner must never stop the continuation it describes.
    return false
  }
}
