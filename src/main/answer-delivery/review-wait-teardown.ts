/**
 * Every way a review-waiting session's terminal ends (archive, close, delete, a crash or the
 * idle closer) marks its wait asleep, so the decision wakes it instead of holding as "not
 * running". A pane that is live again still gets the decision first: the wake checks it.
 */

import { registerPaneKeyTeardownListener } from '../ipc/pty/pane/key-state'
import { noteReviewSessionAsleep } from '../artifacts/artifact-review-sleep-targets'

export function watchReviewWaitTeardown(
  apiOrigin: () => string | null,
  userDataPath: string,
  now: () => number = Date.now
): () => void {
  return registerPaneKeyTeardownListener((paneKey) => {
    try {
      noteReviewSessionAsleep({ paneKey }, apiOrigin(), now(), userDataPath)
    } catch (error) {
      console.warn('[review-wait] could not mark a closed session asleep:', error)
    }
  })
}
