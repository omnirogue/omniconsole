/**
 * What the review and Question adapters share: how the window files the asking conversation
 * (deleted, hidden or archived), and bringing back one the person deleted or hid, recorded as an
 * organization change approved by the person who answered.
 */

import type { SessionManageConversationOrganization } from '../../shared/session-manage-relay'
import { parseSessionReference } from '../../shared/session-reference'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { sessionActionsLogFor } from '../session-manage/session-actions-log'
import { readConversationOrganization } from '../session-manage/session-manage-resume-runtime'
import { sessionOrganizationLedgerFor } from '../session-organization/organization-change-ledger'
import type {
  ClaimableDelivery,
  WorkDeliveryKindAdapter,
  WorkDeliveryTarget
} from '../work-delivery/work-delivery-kind'
import { answerRestoreDeleted } from './restore-deleted-for-answer'

type FoldersRuntime = Pick<OrcaRuntimeService, 'requestSessionFolders'>

/** Who answered on OmniOS (the claimable row's `answeredBy`), for the restore's approval. */
export function answeredByOf(delivery: ClaimableDelivery): string {
  const name = (delivery as ClaimableDelivery & { answeredBy?: unknown }).answeredBy
  return typeof name === 'string' && name.trim() ? name.trim() : 'the person who answered on OmniOS'
}

/** `deleted`/`archived` for a target; nothing when the window cannot say (the resume re-checks). */
export async function organizationFields(
  runtime: FoldersRuntime,
  sessionId: string
): Promise<Pick<WorkDeliveryTarget, 'deleted' | 'archived'>> {
  const organization = await readConversationOrganization(runtime, { hostId: 'local', sessionId })
  if (!organization) {
    return {}
  }
  return {
    ...(organization.deleted || organization.hidden ? { deleted: true } : {}),
    ...(organization.archiveKind ? { archived: true } : {})
  }
}

/** `WorkDeliveryKindAdapter.restoreDeleted`: undelete/unhide only; the claimer then resumes it. */
export function restoreForAnswer(
  userDataPath: string
): NonNullable<WorkDeliveryKindAdapter['restoreDeleted']> {
  return async (delivery, target, runtime) => {
    const reference = parseSessionReference(target.ref)
    if (!reference) {
      throw new Error(`“${target.ref}” is not a conversation reference; nothing was brought back.`)
    }
    const organization: SessionManageConversationOrganization | null =
      await readConversationOrganization(runtime, reference)
    if (!organization) {
      throw new Error(
        'Whether the person deleted it could not be read, so it was not brought back.'
      )
    }
    if (!organization.deleted && !organization.hidden) {
      return
    }
    await answerRestoreDeleted({
      ledger: sessionOrganizationLedgerFor(userDataPath),
      relay: (request) => runtime.requestSessionFolders(request),
      organization: (ref) => readConversationOrganization(runtime, ref),
      audit: (record) => sessionActionsLogFor(userDataPath).append(record)
    })(reference, organization, { deliveryKey: delivery.key, approvedBy: answeredByOf(delivery) })
  }
}
