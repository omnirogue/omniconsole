/**
 * Ending the source's reservation when a move stops before relinquishment, so the source keeps the
 * conversation exactly as before. Only ever before relinquishment: once the source handed the
 * conversation over there is no reservation left, and nothing here could give it back.
 */

import type { SessionHostOrigin } from '../../shared/session-host-authority'
import type { SessionTransferHostPort, HostStepOptions } from './session-transfer-host-port'
import {
  noteRelocationStep,
  type SessionRelocationRecord
} from './session-transfer-relocate-record'

const LOST = new Set(['host-unreachable', 'renegotiate'])

/** True once the source recorded the release (or the reservation already ended). */
export async function releaseRelocationSource(input: {
  port: SessionTransferHostPort
  record: SessionRelocationRecord
  origin: SessionHostOrigin
  operationId: string
  step: HostStepOptions
}): Promise<boolean> {
  const { port, record } = input
  const reservation = record.reservation
  if (!reservation) {
    return true
  }
  const params = {
    operationId: input.operationId,
    conversationId: record.source.conversationId,
    reservation,
    origin: input.origin
  }
  const sleep = input.step.sleep ?? ((ms: number) => new Promise((done) => setTimeout(done, ms)))
  let state = 'host-unreachable'
  let detail: string | undefined
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const reply = await port.release(params)
    if (reply.status === 'ok') {
      state = reply.operation.state
      detail = reply.operation.refusal?.message
      break
    }
    state = reply.refusal.code
    detail = reply.refusal.message
    if (!LOST.has(state)) {
      break
    }
    // Why ask first: the release may have landed; the identical request replays it if so.
    const asked = await port.operation({
      operationId: params.operationId,
      conversationId: params.conversationId
    })
    if (asked.status === 'ok' && asked.found) {
      state = asked.operation.state
      detail = asked.operation.refusal?.message
      break
    }
    await sleep(input.step.pollMs ?? 2_000)
  }
  // Why also observe: a refused release may mean an earlier step already ended the reservation.
  const released = state === 'completed' || (!LOST.has(state) && !(await stillHeld(input)))
  noteRelocationStep(record, {
    step: 'release-source',
    operationId: params.operationId,
    state,
    ...(detail ? { detail } : {})
  })
  if (released) {
    record.reservation = undefined
  }
  return released
}

async function stillHeld(input: {
  port: SessionTransferHostPort
  record: SessionRelocationRecord
}): Promise<boolean> {
  const { conversationId } = input.record.source
  const reply = await input.port.observe({
    conversationIds: [conversationId],
    includeArchived: true
  })
  if (reply.status !== 'ok') {
    return true
  }
  const row = reply.sessions.find((session) => session.conversationId === conversationId)
  return row?.reservation?.operationId === input.record.reservation
}
