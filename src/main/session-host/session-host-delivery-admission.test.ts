import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConversationSource } from '../../shared/conversation-source'
import { fixtureOperationId } from '../../shared/session-host-wire-fixtures'
import { ConversationNotSentError } from '../runtime/conversation-delivery-not-sent'
import {
  deliverUnderSessionHostAdmission,
  SessionHostDeliveryRefusedError
} from './session-host-delivery-admission'
import {
  adoptTestConversation,
  continueRequest,
  FakeSessionHostExecutor,
  remote,
  testHostProcess,
  testHostRoot,
  withoutOrigin,
  type TestHostRoot
} from './session-host-test-fixture'

let host: TestHostRoot
beforeEach(() => {
  host = testHostRoot()
})
afterEach(() => {
  host.dispose()
})

const ADOPTED: ConversationSource = {
  worktreeId: 'wt-1',
  paneKey: 'tab-1:claude-session-1',
  kind: 'pty'
}
const ELSEWHERE: ConversationSource = { worktreeId: 'wt-2', paneKey: 'tab-9:other', kind: 'pty' }

async function adoptedHost() {
  const executor = new FakeSessionHostExecutor()
  const process = testHostProcess({ root: host.root, incarnation: 'runtime-1', executor })
  const service = await process.service()
  const registration = await adoptTestConversation(service)
  return { executor, process, service, registration }
}

function door(
  process: Parameters<typeof deliverUnderSessionHostAdmission>[0]['host'],
  source: ConversationSource,
  n: number,
  deliver = vi.fn(async () => ({ door: 'pty' as const, deliveredAt: 42 }))
) {
  const run = () =>
    deliverUnderSessionHostAdmission({
      host: process,
      source,
      text: 'Next step.',
      operationId: fixtureOperationId(n),
      admission: { writer: 'prompt-queue' },
      deliver
    })
  return { run, deliver }
}

describe('the conversation send door under session host admission', () => {
  it('delivers exactly as before where no registry exists or the conversation is not adopted', async () => {
    const bare = door(null, ADOPTED, 1)
    await expect(bare.run()).resolves.toEqual({ door: 'pty', deliveredAt: 42 })
    const { process, service } = await adoptedHost()
    const other = door(process, ELSEWHERE, 2)
    await expect(other.run()).resolves.toEqual({ door: 'pty', deliveredAt: 42 })
    expect(
      service.operation({
        operationId: fixtureOperationId(2),
        conversationId: 'conv_2437e543a0344939857f71286dd9b814'
      })
    ).toMatchObject({ found: false })
  })

  it('admits a local writer on the current turn, records it, and never resends a replay', async () => {
    const { process, service, registration } = await adoptedHost()
    const first = door(process, ADOPTED, 1)
    await expect(first.run()).resolves.toEqual({ door: 'pty', deliveredAt: 42 })
    await expect(first.run()).resolves.toEqual({ door: 'pty', deliveredAt: 42 })
    expect(first.deliver).toHaveBeenCalledTimes(1)
    expect(
      service.operation({
        operationId: fixtureOperationId(1),
        conversationId: registration.conversationId
      })
    ).toMatchObject({
      operation: { state: 'completed', action: 'continue' }
    })
  })

  it('refuses unsent when another computer holds the turn, and the chain may wait for the next', async () => {
    const { process, service, registration } = await adoptedHost()
    await service.execute(
      withoutOrigin(continueRequest(1, registration.conversationId)),
      remote('paired:mac-b')
    )
    const local = door(process, ADOPTED, 2)
    const refusal = await local.run().catch((error: unknown) => error)
    expect(refusal).toBeInstanceOf(SessionHostDeliveryRefusedError)
    expect(refusal).toBeInstanceOf(ConversationNotSentError)
    expect((refusal as SessionHostDeliveryRefusedError).refusal.code).toBe('turn-reserved')
    expect(local.deliver).not.toHaveBeenCalled()
  })

  it('frees the turn when the door refused before any byte, and fences it when delivery is unknowable', async () => {
    const { process } = await adoptedHost()
    const notSent = door(
      process,
      ADOPTED,
      1,
      vi.fn(async () => {
        throw new ConversationNotSentError('This terminal conversation is no longer open.')
      })
    )
    await expect(notSent.run()).rejects.toBeInstanceOf(ConversationNotSentError)
    const unknown = door(
      process,
      ADOPTED,
      2,
      vi.fn(async () => {
        throw new Error('The PTY write timed out mid-paste.')
      })
    )
    await expect(unknown.run()).rejects.toThrow('mid-paste')
    const blocked = door(process, ADOPTED, 3)
    await expect(blocked.run()).rejects.toMatchObject({
      refusal: { code: 'turn-reserved', current: { operationId: fixtureOperationId(2) } }
    })
    expect(blocked.deliver).not.toHaveBeenCalled()
  })

  it('settles an unconfirmed local write once the conversation took a new turn, so it blocks no longer', async () => {
    const { process, executor, service, registration } = await adoptedHost()
    const unknown = door(
      process,
      ADOPTED,
      1,
      vi.fn(async () => {
        throw new Error('The PTY write timed out mid-paste.')
      })
    )
    await expect(unknown.run()).rejects.toThrow('mid-paste')
    await expect(door(process, ADOPTED, 2).run()).rejects.toMatchObject({
      refusal: { code: 'turn-reserved' }
    })
    executor.turn = 'turn:2'
    const next = door(process, ADOPTED, 3)
    await expect(next.run()).resolves.toEqual({ door: 'pty', deliveredAt: 42 })
    expect(next.deliver).toHaveBeenCalledTimes(1)
    expect(
      service.operation({
        operationId: fixtureOperationId(1),
        conversationId: registration.conversationId
      })
    ).toMatchObject({ operation: { state: 'completed' } })
  })

  it('checks, rather than re-admits, a delivery the host service is dispatching', async () => {
    const { process, executor, service, registration } = await adoptedHost()
    const carried: string[] = []
    executor.prepare = async (input) => ({
      kind: 'dispatch',
      dispatch: async () => {
        const hostOperation = {
          operationId: input.operation.operationId,
          conversationId: registration.conversationId
        }
        await deliverUnderSessionHostAdmission({
          host: process,
          source: ADOPTED,
          text: 'From Studio.',
          operationId: hostOperation.operationId,
          admission: { hostOperation },
          deliver: async () => (
            carried.push(hostOperation.operationId),
            { door: 'pty', deliveredAt: 7 }
          )
        })
        return { kind: 'completed' }
      }
    })
    const result = await service.execute(
      withoutOrigin(continueRequest(4, registration.conversationId)),
      remote('paired:mac-a')
    )
    expect(result).toMatchObject({ status: 'ok', operation: { state: 'completed' } })
    expect(carried).toEqual([fixtureOperationId(4)])
    const forged = deliverUnderSessionHostAdmission({
      host: process,
      source: ADOPTED,
      text: 'x',
      operationId: fixtureOperationId(4),
      admission: {
        hostOperation: {
          operationId: fixtureOperationId(4),
          conversationId: registration.conversationId
        }
      },
      deliver: async () => ({ door: 'pty', deliveredAt: 1 })
    })
    await expect(forged).rejects.toMatchObject({ refusal: { code: 'reservation-invalid' } })
  })

  it('fails closed when the registry exists but cannot be read', async () => {
    const { process } = await adoptedHost()
    writeFileSync(join(host.root, 'registry.json'), 'not json')
    const fresh = testHostProcess({
      root: host.root,
      incarnation: 'runtime-2',
      executor: new FakeSessionHostExecutor()
    })
    const blocked = door(fresh, ELSEWHERE, 1)
    await expect(blocked.run()).rejects.toMatchObject({ refusal: { code: 'storage-unavailable' } })
    expect(blocked.deliver).not.toHaveBeenCalled()
    expect(process.current()).not.toBeNull()
  })
})
