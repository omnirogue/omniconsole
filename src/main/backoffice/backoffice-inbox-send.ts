import { z } from 'zod'
import { peerMessageState } from '../../shared/peer-message-contract'
import { peerSendRequest } from '../../shared/peer-action-contract'
import { consoleMe } from '../../shared/console-companies-contract'
import type {
  BackofficeInboxSendArgs,
  BackofficeInboxSendResult
} from '../../shared/backoffice-work-types'
import { captureConsoleWorkflowPerson } from './console-workflow-person'
import { requestConsoleWorkflow as request } from './console-workflow-transport'

/** The existing person transport binds the sender, selected employee and stored human Inbox. */
export async function sendInboxMessage(
  args: BackofficeInboxSendArgs
): Promise<BackofficeInboxSendResult> {
  const parsed = peerSendRequest.safeParse({
    to: args?.to,
    text: args?.text,
    purpose: args?.purpose ?? 'question',
    references: args?.references ?? [],
    operationId: args?.idempotencyKey
  })
  if (!parsed.success) {
    return {
      ok: false,
      code: 'invalid_request',
      message: 'Choose a colleague and write up to 2 KB, with at most four HTTP(S) references.'
    }
  }
  const { to, text, purpose, references, operationId } = parsed.data
  const captured = await captureConsoleWorkflowPerson()
  if (!captured.ok) {
    return { ok: false, code: captured.error.code, message: captured.error.message }
  }
  const { principal, isCurrent } = captured.data
  const identity = await request(
    '/api/me',
    'GET',
    consoleMe,
    undefined,
    15_000,
    false,
    principal,
    isCurrent
  )
  if (!identity.ok) {
    return { ok: false, code: identity.error.code, message: identity.error.message }
  }
  const sender = identity.data.ok ? identity.data.user?.employee_id : null
  if (!sender || !peerSendRequest.shape.to.safeParse(sender).success) {
    return { ok: false, message: 'Your signed-in account needs a verified employee profile.' }
  }
  const endpoint = z.string().regex(/^(pc|ses)_[A-Za-z0-9_-]{1,120}$/)
  const receipt = z
    .object({
      recipient: z.object({
        employee_id: z.literal(to),
        session_id: endpoint,
        endpoint_kind: z.literal('logical_app'),
        // Older BFFs omit this hint; endpoint ownership must still match the actual message.
        inbox_ready: z.literal(true).optional()
      }),
      message: z.object({
        id: z.string().regex(/^pm_[a-f0-9]{24}$/),
        sender_employee_id: z.literal(sender),
        recipient_employee_id: z.literal(to),
        recipient_session_id: endpoint,
        summary: z.literal(text),
        purpose: z.literal(purpose),
        references: peerSendRequest.shape.references,
        state: peerMessageState
      })
    })
    .refine(
      ({ recipient, message }) =>
        recipient.session_id === message.recipient_session_id &&
        JSON.stringify(message.references) === JSON.stringify(references)
    )
  const sent = await request(
    '/api/peer/send',
    'POST',
    receipt,
    { to, text, purpose, references, idempotency_key: operationId },
    20_000,
    false,
    principal,
    isCurrent,
    undefined,
    { 'Idempotency-Key': operationId }
  )
  if (!sent.ok) {
    return {
      ok: false,
      code: sent.error.code,
      message:
        sent.error.code === 'invalid_response'
          ? 'The message receipt could not be verified. Retry this same message.'
          : sent.error.message
    }
  }
  return { ok: true, body: sent.data }
}
