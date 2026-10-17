/**
 * An answered decision or Question whose conversation the person deleted or hid in the sidebar:
 * answering is their yes to bring it back. The undelete/unhide is a recorded organization change
 * (executor `app/answer-delivery`, the delivery and approver as its reason), then the same
 * conversation resumes. Every other refusal a resume has still applies.
 */

import { randomUUID } from 'node:crypto'
import type { SessionManageConversationOrganization } from '../../shared/session-manage-relay'
import type { SessionManageActor } from '../../shared/session-manage-types'
import type { OrganizationChange } from '../../shared/session-organization-change'
import { formatSessionReference, type SessionReference } from '../../shared/session-reference'
import type { SessionResumeResult } from '../../shared/session-resume-types'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import {
  sessionActionsLogFor,
  type SessionActionAppend
} from '../session-manage/session-actions-log'
import { SessionManagePartialError } from '../session-manage/session-manage-refusal'
import { resumeConversation, type SessionResumeDeps } from '../session-manage/session-manage-resume'
import type { SessionResumeRestoreApproval } from '../session-manage/session-manage-resume-restore'
import {
  readConversationOrganization,
  runtimeResumeDeps
} from '../session-manage/session-manage-resume-runtime'
import {
  sessionOrganizationLedgerFor,
  type OrganizationChangeLedger
} from '../session-organization/organization-change-ledger'
import {
  relayOrganizationChange,
  type OrganizationRelay
} from '../session-organization/organization-relayed-mutation'

export type AnswerRestoreDeps = {
  ledger: Pick<OrganizationChangeLedger, 'prepare' | 'settle'>
  relay: OrganizationRelay
  /** Re-read after the change: a legacy hide entry the change cannot name still hides it. */
  organization(reference: SessionReference): Promise<SessionManageConversationOrganization | null>
  audit(record: SessionActionAppend): Promise<string | undefined>
  newOpId?: () => string
}

export type RestoreDeletedForAnswerResult =
  | { ok: true; restored: boolean; resumed: SessionResumeResult; summary: string }
  /** `partial`: the row was restored or a terminal started before it failed; never retried blind. */
  | { ok: false; restored: boolean; reason: string; partial?: true }

export function answerRestoreReason(approval: SessionResumeRestoreApproval): string {
  return `restored for an answered decision ${approval.deliveryKey}, approved by ${approval.approvedBy}`
}

const TOO_OLD =
  'The OmniConsole window is too old to say which sidebar entry deletes or hides it. Nothing changed.'

/** `SessionResumeDeps.restoreDeleted` through the organization change path, then one audit line. */
export function answerRestoreDeleted(
  deps: AnswerRestoreDeps
): NonNullable<SessionResumeDeps['restoreDeleted']> {
  return async (reference, organization, approval) => {
    const reason = answerRestoreReason(approval)
    const steps: { kind: 'delete' | 'unhide'; keys: string[] | undefined; done: string }[] = []
    if (organization.deleted) {
      steps.push({ kind: 'delete', keys: organization.deletedKeys, done: 'undeleted' })
    }
    if (organization.hidden) {
      steps.push({ kind: 'unhide', keys: organization.hiddenKeys, done: 'unhidden' })
    }
    if (steps.some((step) => !step.keys?.length)) {
      throw new Error(TOO_OLD)
    }
    const applied: string[] = []
    for (const step of steps) {
      const change: OrganizationChange = {
        opId: (deps.newOpId ?? randomUUID)(),
        kind: step.kind,
        targets: step.keys!.map((sessionKey) => ({ sessionKey })),
        value: false,
        executor: { kind: 'app', feature: 'answer-delivery' },
        reason
      }
      try {
        await relayOrganizationChange(deps.ledger, deps.relay, change, {
          actor: { actor: 'answer-delivery' },
          summary: `Answer delivery ${step.done} its conversation: ${reason}`
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // Why name what applied: a delete undone before the unhide failed is not "nothing changed".
        throw new Error(
          applied.length ? `${message} Already done: ${applied.join(', ')}.` : message
        )
      }
      applied.push(step.done)
    }
    const after = await deps.organization(reference)
    if (!after || after.deleted || after.hidden) {
      throw new Error(
        `The window ${applied.join(' and ')} it, but it still reads as ${after ? (after.deleted ? 'deleted' : 'hidden') : 'unreadable'}, so it was not reopened.`
      )
    }
    const summary = `Brought back a conversation the person ${organization.deleted ? 'deleted' : 'hid'} (${applied.join(' and ')}): ${reason}.`
    const auditError = await deps.audit({
      actor: 'answer-delivery',
      action: 'resume',
      target: { title: formatSessionReference(reference) },
      summary,
      reason,
      answerDelivery: { deliveryKey: approval.deliveryKey, approvedBy: approval.approvedBy }
    })
    if (auditError) {
      console.warn(`[answer-delivery] ${auditError}`)
    }
  }
}

/** Resumes `ref` and, when the person deleted or hid it, brings it back first (the answer is the yes). */
export async function restoreDeletedForAnswerWith(
  resumeDeps: Omit<SessionResumeDeps, 'restoreDeleted'>,
  restore: AnswerRestoreDeps,
  input: { ref: string; deliveryKey: string; approvedBy: string; actor: SessionManageActor }
): Promise<RestoreDeletedForAnswerResult> {
  const approval = { deliveryKey: input.deliveryKey.trim(), approvedBy: input.approvedBy.trim() }
  if (!approval.deliveryKey || !approval.approvedBy) {
    return {
      ok: false,
      restored: false,
      reason: 'A restore needs the answered delivery and who approved it. Nothing changed.'
    }
  }
  let restored = false
  const restoreDeleted = answerRestoreDeleted(restore)
  try {
    const resumed = await resumeConversation(
      {
        ...resumeDeps,
        restoreDeleted: async (reference, organization, approved) => {
          await restoreDeleted(reference, organization, approved)
          restored = true
        }
      },
      { actor: input.actor, ref: input.ref, dryRun: false, restoreDeleted: approval }
    )
    const summary = restored
      ? `${resumed.summary} It had been removed from the sidebar; ${answerRestoreReason(approval)}.`
      : resumed.summary
    return { ok: true, restored, resumed, summary }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (restored) {
      // Why say so: the row is back in the sidebar even though the conversation did not reopen.
      const reason = `${message} Already done: brought back to the sidebar (${answerRestoreReason(approval)}).`
      return { ok: false, restored, reason, partial: true }
    }
    return error instanceof SessionManagePartialError
      ? { ok: false, restored, reason: message, partial: true }
      : { ok: false, restored, reason: message }
  }
}

type RestoreRuntime = Parameters<typeof runtimeResumeDeps>[0] &
  Pick<OrcaRuntimeService, 'requestSessionFolders'>

/** The claimer's helper: the real window, ledger and audit log behind `restoreDeletedForAnswerWith`. */
export function restoreDeletedForAnswer(
  runtime: RestoreRuntime,
  input: {
    userDataPath: string
    ref: string
    deliveryKey: string
    approvedBy: string
    actor: SessionManageActor
    launchPreferences?: Parameters<typeof runtimeResumeDeps>[1]['launchPreferences']
    launchCause?: Parameters<typeof runtimeResumeDeps>[1]['launchCause']
  }
): Promise<RestoreDeletedForAnswerResult> {
  const { userDataPath } = input
  return restoreDeletedForAnswerWith(
    runtimeResumeDeps(runtime, {
      userDataPath,
      ...(input.launchCause ? { launchCause: input.launchCause } : {}),
      ...(input.launchPreferences ? { launchPreferences: input.launchPreferences } : {})
    }),
    {
      ledger: sessionOrganizationLedgerFor(userDataPath),
      relay: (request) => runtime.requestSessionFolders(request),
      organization: (reference) => readConversationOrganization(runtime, reference),
      audit: (record) => sessionActionsLogFor(userDataPath).append(record)
    },
    input
  )
}
