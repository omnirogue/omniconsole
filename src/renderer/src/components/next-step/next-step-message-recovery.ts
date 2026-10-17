import { translate } from '@/i18n/i18n'
import {
  recoverPendingHandoff,
  retainPendingHandoff,
  clearPendingHandoff,
  type PendingHandoffRequest
} from '@/components/handoffs/handoff-request-memory'

export type PeerMessageTarget = { kind: 'room' | 'peer'; id: string; title: string }
type MessageIntent = Extract<PendingHandoffRequest, { kind: 'peer-post' | 'peer-reply' }>
type JoinIntent = Extract<PendingHandoffRequest, { kind: 'peer-join' }>
const targetKey = (target: PeerMessageTarget, join: boolean) =>
  `peer:${target.kind}:${target.id}:${join ? 'join' : 'message'}`

export function recoverMessageOperation(scope: string, target: PeerMessageTarget, join = false) {
  const result = recoverPendingHandoff(scope, targetKey(target, join))
  const saved = result.pending
  const expected = join ? 'peer-join' : target.kind === 'room' ? 'peer-post' : 'peer-reply'
  if (
    saved &&
    (saved.kind !== expected ||
      ('roomId' in saved.body
        ? saved.body.roomId
        : 'messageId' in saved.body
          ? saved.body.messageId
          : null) !== target.id)
  ) {
    return {
      pending: null,
      error: translate(
        'discussions.recoveryMismatch',
        'The saved request does not match this discussion. Restore the original request before sending.'
      )
    }
  }
  return { pending: saved as MessageIntent | JoinIntent | null, error: result.error }
}

export function retainMessageOperation(
  scope: string,
  target: PeerMessageTarget,
  text: string
): MessageIntent {
  const recovered = recoverMessageOperation(scope, target)
  if (recovered.error) {
    throw new Error(recovered.error)
  }
  if (recovered.pending && recovered.pending.kind !== 'peer-join') {
    return recovered.pending
  }
  const body = { text, references: [], operationId: crypto.randomUUID() }
  return retainPendingHandoff(
    scope,
    targetKey(target, false),
    target.kind === 'room'
      ? { kind: 'peer-post', body: { ...body, roomId: target.id } }
      : { kind: 'peer-reply', body: { ...body, messageId: target.id } }
  ) as MessageIntent
}

export function retainMessageJoin(scope: string, target: PeerMessageTarget): JoinIntent {
  const recovered = recoverMessageOperation(scope, target, true)
  if (recovered.error) {
    throw new Error(recovered.error)
  }
  if (recovered.pending?.kind === 'peer-join') {
    return recovered.pending
  }
  return retainPendingHandoff(scope, targetKey(target, true), {
    kind: 'peer-join',
    body: { roomId: target.id, operationId: crypto.randomUUID() }
  }) as JoinIntent
}

export function clearMessageOperation(
  scope: string,
  target: PeerMessageTarget,
  operationId: string
) {
  clearPendingHandoff(scope, targetKey(target, false), operationId)
}
