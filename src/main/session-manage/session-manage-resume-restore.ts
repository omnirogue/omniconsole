/**
 * A conversation the person deleted or hid in the sidebar is never reopened by `session resume`,
 * unless an answered decision brings it back first as a recorded change.
 */

import type { SessionManageConversationOrganization } from '../../shared/session-manage-relay'
import type { SessionReference } from '../../shared/session-reference'
import { SessionManageRefusal } from './session-manage-refusal'
import type { LocatedTranscript } from './session-transcript-locate'

/** An answered decision is the person's yes to bring back what they deleted or hid. */
export type SessionResumeRestoreApproval = { deliveryKey: string; approvedBy: string }

export type SessionResumeRestore = {
  /** Undoes the person's sidebar delete or hide as a recorded change; throws when it could not. */
  restoreDeleted?(
    reference: SessionReference,
    organization: SessionManageConversationOrganization,
    approval: SessionResumeRestoreApproval
  ): Promise<void>
}

/** Refuses a deleted or hidden conversation, or restores it for an answer; others pass. */
export async function restoreRemovedForResume(
  deps: SessionResumeRestore & {
    locate(reference: SessionReference): Promise<LocatedTranscript[]>
  },
  reference: SessionReference,
  organization: SessionManageConversationOrganization,
  input: { dryRun: boolean; restoreDeleted?: SessionResumeRestoreApproval }
): Promise<void> {
  if (!organization.deleted && !organization.hidden) {
    return
  }
  const removed = organization.deleted ? 'deleted' : 'hid'
  if (!input.restoreDeleted || !deps.restoreDeleted) {
    throw new SessionManageRefusal(
      `The person ${removed} this conversation in the sidebar on this computer; reopening it would bring it back. Ask them first. Nothing changed.`
    )
  }
  // Why locate first: a conversation that cannot reopen keeps its row deleted.
  if (input.dryRun || (await deps.locate(reference)).length !== 1) {
    return
  }
  try {
    await deps.restoreDeleted(reference, organization, input.restoreDeleted)
  } catch (error) {
    // Why no "Nothing changed": the restore's own message says whether anything changed.
    throw new SessionManageRefusal(
      `The person ${removed} this conversation, and bringing it back for the answer failed: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}
