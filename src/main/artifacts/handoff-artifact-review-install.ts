import { watchReviewWaitTeardown } from '../answer-delivery/review-wait-teardown'
import { consoleHandoffClient } from '../backoffice/console-handoff-client'
import { getConsolePublicationPrincipal } from '../backoffice/console-workflow-person'
import { installHandoffArtifactReviewSend } from '../backoffice/handoff-artifact-review-send'
import { installSessionOutcomeArtifactReviewReader } from '../runtime/session-outcome-artifact-review'
import type { ArtifactCloudService } from './artifact-cloud-service'
import { grantArtifactReviewer } from './artifact-review-grant'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { sourceArtifactReviewPass } from './artifact-source-review-install'
import {
  fileHandoffArtifactReviewWatchStore,
  HandoffArtifactReviewWatch
} from './handoff-artifact-review-watch'

/**
 * Page-review handoffs, end to end on this desktop: make the recipient a named reviewer before a
 * request leaves, remember the thread, read the page's decision back into the review gate, and post
 * it into the thread for the sender. Returns the teardown.
 */
export function installHandoffArtifactReviews(
  service: ArtifactCloudService,
  userDataPath: string,
  runtime?: OrcaRuntimeService
): () => void {
  const watch = new HandoffArtifactReviewWatch({
    store: fileHandoffArtifactReviewWatchStore(userDataPath),
    principal: getConsolePublicationPrincipal,
    getThread: (args) => consoleHandoffClient.get(args),
    respond: (args) => consoleHandoffClient.respond(args),
    reviewStatus: (slug) => service.reviewStatus({ slug }),
    ...(runtime ? { sourceReviews: sourceArtifactReviewPass(service, userDataPath, runtime) } : {})
  })
  installHandoffArtifactReviewSend({
    grant: (input) => grantArtifactReviewer(service, input),
    sent: ({ threadId, review, recipient }) => {
      void getConsolePublicationPrincipal()
        .then((sender) => {
          if (sender) {
            watch.track({ threadId, review, recipient, sender })
          }
        })
        .catch(() => {})
    }
  })
  installSessionOutcomeArtifactReviewReader(async (slug) => {
    const read = await service.reviewStatus({ slug })
    return read.status === 'ok' ? read.value : null
  })
  watch.start()
  // Why with the source reviews: only they can wake a session whose terminal ended mid-wait.
  const stopTeardownWatch = runtime
    ? watchReviewWaitTeardown(() => service.apiOrigin(), userDataPath)
    : null
  return () => {
    watch.stop()
    stopTeardownWatch?.()
    installHandoffArtifactReviewSend(null)
    installSessionOutcomeArtifactReviewReader(null)
  }
}
