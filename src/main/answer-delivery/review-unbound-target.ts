/**
 * A review decision for a page no share record on this computer and no OmniOS binding ties to a
 * session: the asking session its `choices` sidecar names (in the folder the sidecar recorded),
 * else the session whose publish call returned the page. Nothing found stays a visible `not_found`.
 */

import { formatSessionReference } from '../../shared/session-reference'
import type { WorkDeliveryTarget } from '../work-delivery/work-delivery-kind'
import { choicesNotifySession, type ChoicesSidecar } from './choices-sidecar'
import type { PublishingTranscript } from './review-publisher-scan'

export type UnboundReviewDeps = {
  localHost: string
  /** This computer's Claude transcript paths for a session id. */
  locate(sessionId: string): Promise<string[]>
  readCwd(transcriptPath: string): Promise<string | null>
  findPublisher(slug: string): Promise<PublishingTranscript | null>
  organization(sessionId: string): Promise<Pick<WorkDeliveryTarget, 'deleted' | 'archived'>>
}

async function targetFor(
  sessionId: string,
  folder: string | null,
  transcript: WorkDeliveryTarget['transcript'],
  deps: UnboundReviewDeps
): Promise<WorkDeliveryTarget> {
  return {
    ref: formatSessionReference({ agent: 'claude', sessionId, hostId: 'local' }),
    ...(folder ? { folder } : {}),
    ...(await deps.organization(sessionId)),
    transcript
  }
}

export async function unboundReviewTarget(
  slug: string,
  sidecar: ChoicesSidecar | null,
  deps: UnboundReviewDeps
): Promise<WorkDeliveryTarget | null> {
  const asking = sidecar ? choicesNotifySession(sidecar, deps.localHost) : null
  if (sidecar && asking) {
    const located = await deps.locate(asking.sessionId)
    // Why: another computer's session is that computer's to deliver to.
    if (located.length > 0 || asking.thisHost) {
      const folder = sidecar.cwd ?? (located[0] ? await deps.readCwd(located[0]) : null)
      return targetFor(asking.sessionId, folder, located.length > 0 ? 'present' : 'gone', deps)
    }
  }
  const publisher = await deps.findPublisher(slug)
  if (!publisher) {
    return null
  }
  return targetFor(publisher.sessionId, await deps.readCwd(publisher.path), 'present', deps)
}
