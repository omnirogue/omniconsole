import {
  peerPostRequest,
  peerJoinRequest,
  peerReplyRequest,
  peerSendRequest
} from '../../../../shared/peer-action-contract'
import { normalizeSessionFollowUpRule } from '../../../../shared/session-follow-up-rule'
import { translate } from '@/i18n/i18n'
import { z } from 'zod'
import { chatDeliveryDraft, chatRecipient, chatAttachment } from '../../../../shared/chat-delivery'
import { communicationType } from '../../../../shared/communication-type'
import { peerMessageArchiveRequest } from '../../../../shared/peer-message-contract'
import { WorkflowRequestError } from '@/lib/console-workflow-client'
import {
  handoffSend,
  handoffForward,
  handoffDecide,
  handoffRespond,
  handoffArchive,
  handoffReturn
} from '../../../../shared/console-handoff-contract'

const returnMetadata = handoffReturn
  .omit({ file: true })
  .extend({ file: handoffReturn.shape.file.omit({ contentBase64: true }) })
const sessionRule = z.unknown().transform((value, context) => {
  const rule = normalizeSessionFollowUpRule(value)
  if (!rule) {
    context.addIssue({
      code: 'custom',
      message: translate('handoffs.savedSessionInvalid', 'The saved session handoff is invalid.')
    })
    return z.NEVER
  }
  return rule
})
const pendingRequest = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('peer-archive'), body: peerMessageArchiveRequest }),
  z.object({ kind: z.literal('peer-send'), body: peerSendRequest }),
  z.object({ kind: z.literal('peer-post'), body: peerPostRequest }),
  z.object({ kind: z.literal('peer-join'), body: peerJoinRequest }),
  z.object({ kind: z.literal('peer-reply'), body: peerReplyRequest }),
  z.object({
    kind: z.literal('chat'),
    body: z.object({
      operationId: z.string().min(8),
      draft: chatDeliveryDraft,
      receipts: z.record(
        z.string(),
        z.object({ id: z.string(), kind: z.enum(['person', 'agent']) })
      )
    })
  }),
  z.object({
    kind: z.literal('session'),
    body: z.object({ operationId: z.string().min(8), rule: sessionRule })
  }),
  z.object({ kind: z.literal('send'), body: handoffSend }),
  z.object({ kind: z.literal('forward'), body: handoffForward }),
  z.object({ kind: z.literal('review'), body: handoffDecide }),
  z.object({ kind: z.literal('respond'), body: handoffRespond }),
  z.object({
    kind: z.literal('materialize'),
    body: z.object({
      threadId: z.string().min(1),
      workspacePath: z.string().min(1).max(4096),
      filesOnly: z.literal(true),
      operationId: z.string().min(8)
    })
  }),
  z.object({ kind: z.literal('archive'), body: handoffArchive }),
  z.object({ kind: z.literal('return'), body: returnMetadata })
])
export type PendingHandoffRequest = z.infer<typeof pendingRequest>
const key = (scope: string, target: string) => `handoff-request-v1:${scope}:${target}`

/** Only retry metadata is local; task, review and delivery state remain server-owned. */
export function readPendingHandoff(scope: string, target: string): PendingHandoffRequest | null {
  const raw = localStorage.getItem(key(scope, target))
  if (!raw) {
    return null
  }
  if (raw.length > 80_000) {
    throw new Error('The saved request could not be recovered safely.')
  }
  return pendingRequest.parse(JSON.parse(raw))
}
export function retainPendingHandoff(
  scope: string,
  target: string,
  input: PendingHandoffRequest
): PendingHandoffRequest {
  const validated = pendingRequest.parse(input)
  const existing = readPendingHandoff(scope, target)
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(validated)) {
      throw new Error('Retry the original request before changing this action.')
    }
    return existing
  }
  const encoded = JSON.stringify(validated)
  if (encoded.length > 80_000) {
    throw new Error('The handoff metadata exceeds its saved limit.')
  }
  localStorage.setItem(key(scope, target), encoded)
  return validated
}
export function clearPendingHandoff(scope: string, target: string, operationId: string): void {
  if (readPendingHandoff(scope, target)?.body.operationId === operationId) {
    localStorage.removeItem(key(scope, target))
  }
}

export function recoverPendingHandoff(
  scope: string,
  target: string
): { pending: PendingHandoffRequest | null; error: string } {
  try {
    return { pending: readPendingHandoff(scope, target), error: '' }
  } catch {
    return {
      pending: null,
      error: translate(
        'handoffs.theSavedRequestCouldNot7d11d',
        'The saved request could not be recovered safely. Restore access to saved app data before sending again.'
      )
    }
  }
}

/** These responses reject admission. Timeouts, transport loss and 409 retain the original operation. */
export function isRejectedHandoff(error: unknown): boolean {
  return (
    error instanceof WorkflowRequestError &&
    ([400, 401, 403, 404, 422].includes(error.detail.status ?? 0) ||
      (error.detail.status === 409 &&
        ['file_version_changed', 'approval_version_changed'].includes(error.detail.code)))
  )
}

/** Update delivery receipts under the original key without changing the pending request identity. */
export function updatePendingSessionHandoff(
  scope: string,
  target: string,
  input: Extract<PendingHandoffRequest, { kind: 'session' }>
): void {
  const previous = readPendingHandoff(scope, target)
  if (previous?.kind !== 'session' || previous.body.operationId !== input.body.operationId) {
    throw new Error('The pending session handoff changed. Reopen it before retrying.')
  }
  const encoded = JSON.stringify(pendingRequest.parse(input))
  if (encoded.length > 80_000) {
    throw new Error('The session handoff metadata exceeds its saved limit.')
  }
  localStorage.setItem(key(scope, target), encoded)
}

export function updatePendingChatHandoff(
  scope: string,
  target: string,
  input: Extract<PendingHandoffRequest, { kind: 'chat' }>
): void {
  const previous = readPendingHandoff(scope, target)
  if (
    previous?.kind !== 'chat' ||
    previous.body.operationId !== input.body.operationId ||
    JSON.stringify(previous.body.draft) !== JSON.stringify(input.body.draft)
  ) {
    throw new Error('The saved message changed. Reopen it before retrying.')
  }
  const encoded = JSON.stringify(pendingRequest.parse(input))
  if (encoded.length > 80_000) {
    throw new Error('The message metadata exceeds its saved limit.')
  }
  localStorage.setItem(key(scope, target), encoded)
}

const chatView = z.object({
  draft: z
    .object({
      message: z.string().max(8192),
      recipients: z.array(chatRecipient).max(20),
      attachments: z.array(chatAttachment).max(32),
      communicationType
    })
    .nullable(),
  sent: z
    .array(
      z.object({
        recipients: z.array(chatRecipient).max(20),
        receipts: z.record(
          z.string(),
          z.object({ id: z.string(), kind: z.enum(['person', 'agent']) })
        )
      })
    )
    .max(20)
})
export type HandoffChatView = z.infer<typeof chatView>
const chatViewKey = (scope: string, target: string) => `${key(scope, target)}:view`

/** Draft routing and links to server-owned receipts, never a second copy of delivery state. */
export function readHandoffChatView(scope: string, target: string): HandoffChatView {
  const raw = localStorage.getItem(chatViewKey(scope, target))
  if (!raw) {
    return { draft: null, sent: [] }
  }
  if (raw.length > 80_000) {
    throw new Error('The saved chat could not be recovered safely.')
  }
  return chatView.parse(JSON.parse(raw))
}

export function writeHandoffChatView(scope: string, target: string, view: HandoffChatView): void {
  const retained = chatView.parse(view)
  let encoded = JSON.stringify(retained)
  while (encoded.length > 80_000 && retained.sent.length > 1) {
    retained.sent.shift()
    encoded = JSON.stringify(retained)
  }
  if (encoded.length > 80_000) {
    throw new Error('The chat metadata exceeds its saved limit.')
  }
  if (!view.draft && view.sent.length === 0) {
    localStorage.removeItem(chatViewKey(scope, target))
  } else {
    localStorage.setItem(chatViewKey(scope, target), encoded)
  }
}
