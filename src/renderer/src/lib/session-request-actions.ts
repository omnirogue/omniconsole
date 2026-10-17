import { translate } from '@/i18n/i18n'
import { handoffApi } from '@/components/handoffs/handoff-client'
import { workflowData } from '@/lib/console-workflow-client'
import { HANDOFF_MANIFEST_NAME } from '../../../shared/handoff-manifest'
import {
  sessionRequestHandoffOperationId,
  sessionRequestDoneOperationId,
  sessionRequestOperationId
} from '../../../shared/handoff-operation-ids'
import { handoffBranchName } from '../../../shared/handoff-route-preparation'
import {
  SESSION_REQUEST_ACTION,
  buildSessionRequestBody,
  parseSessionRequestBody,
  sessionHandoverMemo,
  sessionRequestTitle,
  type SessionRequest
} from '../../../shared/session-request'

/**
 * The two halves of asking for somebody's session and getting it.
 *
 * Asking is one ordinary handoff, so the request is visible in both people's tabs from the moment
 * it is made. Accepting is where the work actually moves: the owner's uncommitted work is
 * committed on the handoff branch and pushed, the manifest goes with it, the session is handed to
 * the asker, and the request thread is resolved — so the request leaves both tabs at the same
 * moment the session appears in the asker's Needs You.
 */
export type SessionRequestOutcome = { ok: true; threadId: string } | { ok: false; message: string }

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Ask the person running a session to hand it over. */
export async function requestSession(input: {
  ownerEmployeeId: string
  requesterEmployeeId: string
  requesterName: string
  request: SessionRequest
}): Promise<SessionRequestOutcome> {
  const key = input.request.ledgerId ?? input.request.workspacePath
  try {
    const receipt = workflowData(
      await handoffApi().sendCardless({
        title: sessionRequestTitle(input.request.sessionLabel, input.requesterName),
        recipient: input.ownerEmployeeId,
        action: SESSION_REQUEST_ACTION,
        note: buildSessionRequestBody(input.request),
        operationId: sessionRequestOperationId(key, input.requesterEmployeeId),
        attachments: []
      })
    )
    return receipt.thread_id
      ? { ok: true, threadId: receipt.thread_id }
      : {
          ok: false,
          message: translate(
            'sessionRequest.missingThread',
            'The hub answered without a thread. Try again.'
          )
        }
  } catch (error) {
    return { ok: false, message: errorText(error) }
  }
}

export type AcceptedSessionRequest = {
  /** The handoff that carries the session to the asker. */
  threadId: string
  branch: string | null
  sha: string | null
}

/**
 * Accept a request: commit and push the work in progress, hand the session to whoever asked, then
 * resolve the request. Each step is only taken once the one before it succeeded, so a failure
 * leaves the request open rather than half-answered.
 */
export async function acceptSessionRequest(input: {
  threadId: string
  requesterEmployeeId: string
  ownerName: string
  requestBody: string
  /** Falls back to the request's own workspace when the owner does not name one. */
  workspacePath?: string
  ledgerUrl?: string
}): Promise<{ ok: true; data: AcceptedSessionRequest } | { ok: false; message: string }> {
  const request = parseSessionRequestBody(input.requestBody)
  if (!request) {
    return {
      ok: false,
      message: translate('sessionRequest.notRequest', 'This thread is not a request for a session.')
    }
  }
  const workspacePath = input.workspacePath ?? request.workspacePath
  const branch = handoffBranchName(request.ledgerId ?? input.threadId)
  const memo = sessionHandoverMemo({
    sessionLabel: request.sessionLabel,
    reason: request.reason,
    ownerName: input.ownerName
  })
  const prepared = await handoffApi().prepareRoutes({
    workspacePath,
    branch,
    label: request.sessionLabel,
    memo,
    pins: [],
    trail: {
      ...(request.ledgerId ? { ledgerId: request.ledgerId } : {}),
      ...(input.ledgerUrl ? { ledgerUrl: input.ledgerUrl } : {}),
      requestThreadId: input.threadId
    },
    next: 'person',
    sameWorktree: false,
    // The point of asking for a live session is the work in progress, not only its outputs.
    includeWorkingTree: true
  })
  if (!prepared.ok) {
    return { ok: false, message: prepared.error.message }
  }
  if (prepared.data.refused.length > 0) {
    return { ok: false, message: prepared.data.refused.map((entry) => entry.reason).join(' ') }
  }
  const manifestPin = prepared.data.pins.find((pin) => pin.name === HANDOFF_MANIFEST_NAME)
  const note = [memo, '', ...prepared.data.memoLines].join('\n').slice(0, 8192)
  let handoffThreadId: string
  try {
    const attachments = await Promise.all(
      prepared.data.pins
        .filter((pin) => pin.sourcePath)
        .map(async (pin) =>
          workflowData(await handoffApi().readFile({ filePath: pin.sourcePath! }))
        )
    )
    const receipt = workflowData(
      await handoffApi().sendCardless({
        title: `${request.sessionLabel}`.slice(0, 160),
        recipient: input.requesterEmployeeId,
        action: 'review',
        note,
        operationId: sessionRequestHandoffOperationId(input.threadId, input.requesterEmployeeId),
        attachments
      })
    )
    if (!receipt.thread_id) {
      return {
        ok: false,
        message: translate(
          'sessionRequest.missingThread',
          'The hub answered without a thread. Try again.'
        )
      }
    }
    handoffThreadId = receipt.thread_id
  } catch (error) {
    return { ok: false, message: errorText(error) }
  }
  try {
    // Only now: the request is answered because the session has actually gone.
    workflowData(
      await handoffApi().respond({
        threadId: input.threadId,
        kind: 'done',
        note: `Handed over. ${manifestPin ? 'The work package is on the new thread.' : ''}`.trim(),
        operationId: sessionRequestDoneOperationId(input.threadId)
      })
    )
  } catch (error) {
    return {
      ok: false,
      message: translate(
        'sessionRequest.closeFailed',
        'The session was handed over, but this request stayed open: {{error}}',
        { error: errorText(error) }
      )
    }
  }
  return {
    ok: true,
    data: {
      threadId: handoffThreadId,
      branch: prepared.data.git?.branch ?? null,
      sha: prepared.data.git?.sha ?? null
    }
  }
}

export { parseSessionRequestBody }
