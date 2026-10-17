/**
 * This Mac's own automatic writers (its prompt queue, Keep going, chains, Up next, the steward's
 * prompts) to a conversation an SSH relay runs and has adopted: delivered through that relay's
 * admission (`sessionHost.execute` with `deliver`), never as raw PTY bytes, so a remote continue
 * and this Mac's own driver can never both take one turn. A relay that does not advertise delivery,
 * or has not adopted the conversation, keeps today's path. A person typing is never routed here.
 */

import { randomUUID } from 'node:crypto'
import {
  conversationDeliveryOperationId,
  type ConversationSource
} from '../../shared/conversation-source'
import { parseExecutionHostId } from '../../shared/execution-host'
import { SESSION_CONTROL_DELIVERY_CAPABILITY } from '../../shared/session-host-capabilities'
import type { SessionHostClient } from '../../shared/session-host-client'
import { isSessionHostOperationId } from '../../shared/session-host-identity'
import {
  isSessionHostRefusalCode,
  sessionHostRefusal,
  type SessionHostReceivedRefusal
} from '../../shared/session-host-refusal'
import { SessionHostDeliveryRefusedError } from '../session-host/session-host-delivery-admission'

export type SshDeliveryRuntime = {
  resolveTerminalPane(paneKey: string, worktreeId?: string): { executionHostId?: string | null }
}

export type SshDelivered = { door: 'pty'; deliveredAt: number }

const UNKNOWN =
  'The SSH host did not answer after the prompt was sent to it, so whether it arrived is unknown. It is not sent again.'

function refused(refusal: SessionHostReceivedRefusal): SessionHostDeliveryRefusedError {
  return new SessionHostDeliveryRefusedError(
    sessionHostRefusal(
      isSessionHostRefusalCode(refusal.code) ? refusal.code : 'not-eligible',
      refusal.message
    )
  )
}

function sshConnectionOf(runtime: SshDeliveryRuntime, source: ConversationSource): string | null {
  if (source.kind !== 'pty') {
    return null
  }
  try {
    const host = parseExecutionHostId(
      runtime.resolveTerminalPane(source.paneKey, source.worktreeId).executionHostId ?? null
    )
    return host?.kind === 'ssh' ? host.targetId : null
  } catch {
    return null
  }
}

/** Null when today's path applies; otherwise the relay's delivery, or a throw saying why not. */
export async function deliverThroughSshSessionHost(input: {
  runtime: SshDeliveryRuntime
  source: ConversationSource
  text: string
  operationId: string
  writer: string
  unattended: boolean
  computer: string
  clientFor(connectionId: string): SessionHostClient | null
  now?: () => number
}): Promise<SshDelivered | null> {
  const connectionId = sshConnectionOf(input.runtime, input.source)
  const client = connectionId ? input.clientFor(connectionId) : null
  if (!client) {
    return null
  }
  const negotiation = client.negotiation() ?? (await client.negotiate())
  if (!negotiation) {
    // Why not today's path: this relay may run the conversation's admission; nothing was sent.
    throw refused({
      code: 'host-unreachable',
      message: 'Its SSH host could not be asked, so nothing was sent.'
    })
  }
  if (!negotiation.agreed.includes(SESSION_CONTROL_DELIVERY_CAPABILITY)) {
    return null
  }
  const observed = await client.observe({})
  if (observed.status === 'refused') {
    throw refused(observed.refusal)
  }
  const session = observed.sessions.find((entry) => entry.ref.paneKey === input.source.paneKey)
  if (!session || session.admission === 'not-adopted') {
    return null
  }
  const reply = await client.execute({
    operationId: isSessionHostOperationId(input.operationId)
      ? input.operationId
      : conversationDeliveryOperationId('prompt-queue', randomUUID().replaceAll('-', '')),
    conversationId: session.conversationId,
    expectedOwnerEpoch: session.ownerEpoch,
    expectedTurnRevision: session.turnRevision,
    origin: {
      computer: input.computer,
      requester: input.unattended
        ? { kind: 'cli', unattended: { source: 'rules' } }
        : { kind: 'person', via: input.writer }
    },
    action: 'deliver',
    payload: { text: input.text, writer: input.writer }
  })
  if (reply.status === 'refused') {
    // Why unknown for unreachable: the request may have been admitted before the reply was lost.
    if (reply.refusal.code === 'host-unreachable') {
      throw new Error(UNKNOWN)
    }
    throw refused(reply.refusal)
  }
  const { operation } = reply
  if (operation.state === 'completed') {
    const at = (operation.result as { deliveredAt?: unknown } | undefined)?.deliveredAt
    return { door: 'pty', deliveredAt: typeof at === 'number' ? at : (input.now ?? Date.now)() }
  }
  if (operation.state === 'refused' && operation.refusal) {
    throw refused(operation.refusal)
  }
  throw new Error(UNKNOWN)
}
