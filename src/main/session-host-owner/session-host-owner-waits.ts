/**
 * `wait.register`, `wait.cancel` and `sessionHost.waitStatus`: another computer's session waits on
 * one this host runs. Registration is durable before its receipt goes back, so the waiting side may
 * count the wait as established only once it holds that receipt; an unconfirmed registration is an
 * uncertain wait and blocks automatic archive here until it is reconciled.
 */

import type { SessionHostPayloads } from '../../shared/session-host-payload-schema'
import type {
  SessionHostWaitStatusParams,
  SessionHostWaitStatusResult
} from '../../shared/session-host-protocol'
import { sessionHostRefusal } from '../../shared/session-host-refusal'
import type { SessionHostPrepared } from '../session-host/session-host-executor'
import type { SessionHostJournal } from '../session-host/session-host-journal'
import { stewardSwitchRefusal } from '../session-manage/session-manage-unattended'
import { hostWaitReceipt, type HostWaitRegistry } from './host-wait-registry'

export function prepareHostWaitRegister(
  registry: HostWaitRegistry,
  request: { operationId: string; conversationId: string },
  payload: SessionHostPayloads['wait.register']
): SessionHostPrepared {
  const off = stewardSwitchRefusal('sessionWaits')
  if (off) {
    return { kind: 'refuse', refusal: sessionHostRefusal('automation-disabled', off) }
  }
  return {
    kind: 'dispatch',
    dispatch: async () => {
      const record = await registry.register({
        registration: request.operationId,
        dependency: request.conversationId,
        waiter: payload.waiter,
        ...(payload.deadline !== undefined ? { deadline: payload.deadline } : {})
      })
      return { kind: 'completed', result: { receipt: hostWaitReceipt(record) } }
    }
  }
}

export function prepareHostWaitCancel(
  registry: HostWaitRegistry,
  request: { conversationId: string },
  payload: SessionHostPayloads['wait.cancel']
): SessionHostPrepared {
  const held = registry.get(payload.registration)
  if (!held || held.dependency !== request.conversationId) {
    return {
      kind: 'refuse',
      refusal: sessionHostRefusal(
        'invalid-request',
        'That computer holds no such wait on this conversation. Nothing was changed.'
      )
    }
  }
  return {
    kind: 'dispatch',
    dispatch: async () => {
      const record = await registry.cancel(payload.registration)
      return { kind: 'completed', result: { receipt: record ? hostWaitReceipt(record) : null } }
    }
  }
}

export function hostWaitStatus(
  registry: HostWaitRegistry,
  params: SessionHostWaitStatusParams
): SessionHostWaitStatusResult {
  const record = registry.get(params.registration)
  return record && record.dependency === params.dependency
    ? { status: 'ok', receipt: hostWaitReceipt(record) }
    : {
        status: 'refused',
        refusal: sessionHostRefusal(
          'invalid-request',
          'That computer holds no such wait on this conversation.'
        )
      }
}

/** A wait whose registration was admitted but never recorded as settled: it may exist. */
export function hasUncertainWaitRegistration(
  journal: SessionHostJournal | null,
  conversationId: string
): boolean {
  return Object.values(journal?.operations ?? {}).some(
    (operation) =>
      operation.action === 'wait.register' &&
      operation.conversationId === conversationId &&
      (operation.state === 'dispatched' || operation.state === 'unconfirmed')
  )
}
