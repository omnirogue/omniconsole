import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sessionHostRetryRule } from '../../shared/session-host-refusal'
import { sessionHostTurnReservationKey } from '../../shared/session-host-identity'
import type {
  SessionHostExecuteResult,
  SessionHostRequest
} from '../../shared/session-host-protocol'
import { fixtureOperationId } from '../../shared/session-host-wire-fixtures'
import { sessionHostConversationHolder } from './session-host-admission-facts'
import { SessionHostStorageError } from './session-host-journal-file'
import { reconcileSessionHostOperation } from './session-host-reservation-release'
import {
  adoptTestConversation,
  continueRequest,
  FakeSessionHostExecutor,
  MAC_A,
  MAC_B,
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

const MAC_A_PEER = remote('paired:mac-a')
const MAC_B_PEER = remote('paired:mac-b', MAC_B)

function operationOf(result: SessionHostExecuteResult) {
  if (result.status !== 'ok') {
    throw new Error(
      `expected a recorded operation, got ${result.refusal.code}: ${result.refusal.message}`
    )
  }
  return result.operation
}

function archiveRequest(n: number, conversationId: string): SessionHostRequest<'archive'> {
  return {
    operationId: fixtureOperationId(n),
    conversationId,
    expectedOwnerEpoch: 1,
    expectedTurnRevision: 'turn:1',
    expectedOrganizationRevision: 'org:1',
    origin: MAC_A,
    action: 'archive',
    payload: {}
  }
}

async function startedHost(incarnation = 'runtime-1', dead: string[] = []) {
  const executor = new FakeSessionHostExecutor()
  const process = testHostProcess({ root: host.root, incarnation, executor, dead })
  const service = await process.service()
  return { executor, process, service }
}

describe('one admitted action per turn', () => {
  it('two Macs with different operation ids for the same idle turn: exactly one continuation', async () => {
    const { executor, service } = await startedHost()
    const { conversationId } = await adoptTestConversation(service)
    const [a, b] = await Promise.all([
      service.execute(withoutOrigin(continueRequest(1, conversationId)), MAC_A_PEER),
      service.execute(
        withoutOrigin(continueRequest(2, conversationId, { origin: MAC_B })),
        MAC_B_PEER
      )
    ])
    const states = [operationOf(a), operationOf(b)].map((operation) => operation.state).sort()
    expect(states).toEqual(['completed', 'refused'])
    const loser = [operationOf(a), operationOf(b)].find(
      (operation) => operation.state === 'refused'
    )!
    expect(loser.refusal?.code).toBe('turn-reserved')
    expect(executor.dispatched).toHaveLength(1)
    // A later request that echoes the same (unchanged) turn still loses: the turn is consumed.
    const late = await service.execute(
      withoutOrigin(continueRequest(3, conversationId)),
      MAC_B_PEER
    )
    expect(operationOf(late).refusal?.code).toBe('turn-reserved')
    expect(executor.dispatched).toHaveLength(1)
    // The next turn is free again.
    executor.turn = 'turn:2'
    const next = await service.execute(
      withoutOrigin(continueRequest(4, conversationId, { expectedTurnRevision: 'turn:2' })),
      MAC_B_PEER
    )
    expect(operationOf(next).state).toBe('completed')
    expect(executor.dispatched).toHaveLength(2)
  })

  it('a duplicate id returns its recorded outcome and a changed payload is refused unrecorded', async () => {
    const { executor, service } = await startedHost()
    const { conversationId } = await adoptTestConversation(service)
    const request = withoutOrigin(continueRequest(1, conversationId))
    const first = operationOf(await service.execute(request, MAC_A_PEER))
    const again = operationOf(await service.execute(request, MAC_A_PEER))
    expect(again).toEqual(first)
    expect(executor.dispatched).toEqual([first.operationId])
    const changed = await service.execute(
      { ...request, payload: { answer: { kind: 'prompt', text: 'Something else.' } } },
      MAC_A_PEER
    )
    expect(changed).toMatchObject({ status: 'refused', refusal: { code: 'operation-conflict' } })
    expect(service.operation({ operationId: first.operationId, conversationId })).toMatchObject({
      found: true,
      operation: { state: 'completed', fingerprint: first.fingerprint }
    })
  })

  it('records every admission refusal, so a stale request replays the same answer', async () => {
    const { service } = await startedHost()
    const { conversationId } = await adoptTestConversation(service)
    const stale = withoutOrigin(
      continueRequest(1, conversationId, { expectedTurnRevision: 'turn:0' })
    )
    const refused = operationOf(await service.execute(stale, MAC_A_PEER))
    expect(refused).toMatchObject({ state: 'refused', refusal: { code: 'stale-turn' } })
    expect(sessionHostRetryRule(refused.refusal!.code)).toBe('new-operation-after-observe')
    expect(operationOf(await service.execute(stale, MAC_A_PEER))).toEqual(refused)
  })

  it('an unattended caller is refused a relocation it may only propose', async () => {
    const { executor, service } = await startedHost()
    const { conversationId } = await adoptTestConversation(service)
    const result = await service.execute(
      {
        operationId: fixtureOperationId(9),
        conversationId,
        expectedOwnerEpoch: 1,
        expectedTurnRevision: 'turn:1',
        action: 'relocate.freeze-source',
        payload: {
          relocation: fixtureOperationId(90),
          provider: 'claude',
          destination: { hostId: 'host_f06cee505b3645bab00814b2f849e567' }
        }
      },
      { kind: 'steward', feature: 'rules' }
    )
    expect(operationOf(result).refusal?.code).toBe('unattended-restricted')
    expect(executor.dispatched).toEqual([])
  })

  it('treats this host’s own unattended callers (Phase 2 actors) as unattended too', async () => {
    const { executor, service } = await startedHost()
    const { conversationId } = await adoptTestConversation(service)
    const freeze = (n: number) => ({
      operationId: fixtureOperationId(n),
      conversationId,
      expectedOwnerEpoch: 1,
      expectedTurnRevision: 'turn:1',
      action: 'relocate.freeze-source' as const,
      payload: {
        relocation: fixtureOperationId(90),
        provider: 'claude' as const,
        destination: { hostId: 'host_f06cee505b3645bab00814b2f849e567' }
      }
    })
    for (const [n, actor] of [
      [10, { kind: 'steward', feature: 'cleanup-run', runId: 'run-7' }],
      [11, { kind: 'cli', unattended: { source: 'rules' } }]
    ] as const) {
      const result = await service.execute(freeze(n), { kind: 'local', actor })
      expect(operationOf(result).refusal?.code).toBe('unattended-restricted')
    }
    const journal = service.store.snapshot()!
    expect(journal.operations[fixtureOperationId(10)]).toMatchObject({
      holder: 'steward:cleanup-run',
      audit: { authority: 'steward', requester: 'cleanup-run run-7' }
    })
    expect(journal.operations[fixtureOperationId(11)]).toMatchObject({
      holder: 'local:cli',
      audit: { authority: 'local', requester: 'cli (unattended: rules)' }
    })
    expect(executor.dispatched).toEqual([])
  })

  it('stamps every delivered message with where it came from', async () => {
    const { executor, service } = await startedHost()
    const { conversationId } = await adoptTestConversation(service)
    await service.execute(withoutOrigin(continueRequest(1, conversationId)), MAC_A_PEER)
    expect(executor.marks).toEqual(['[from Release notes on Studio] '])
  })
})

describe('a crash at every dispatch boundary never produces a duplicate', () => {
  it('before the admission write: nothing is recorded and the identical retry runs once', async () => {
    const first = await startedHost('runtime-1')
    const { conversationId } = await adoptTestConversation(first.service)
    vi.spyOn(first.service.store.file, 'write').mockImplementationOnce(() => {
      throw new SessionHostStorageError('Power was lost before the record reached the disk.')
    })
    const request = withoutOrigin(continueRequest(1, conversationId))
    const lost = await first.service.execute(request, MAC_A_PEER)
    expect(lost).toMatchObject({ status: 'refused', refusal: { code: 'storage-unavailable' } })
    expect(
      first.service.operation({ operationId: fixtureOperationId(1), conversationId })
    ).toMatchObject({ found: false })

    const restarted = await startedHost('runtime-2', ['runtime-1'])
    await adoptTestConversation(restarted.service)
    const retried = operationOf(await restarted.service.execute(request, MAC_A_PEER))
    expect(retried.state).toBe('completed')
    expect([...first.executor.dispatched, ...restarted.executor.dispatched]).toEqual([
      fixtureOperationId(1)
    ])
  })

  it('after the admission write, before dispatch: reconciled as never sent, the turn freed, nothing resent', async () => {
    const first = await startedHost('runtime-1')
    const { conversationId } = await adoptTestConversation(first.service)
    first.executor.prepare = () => new Promise<never>(() => {})
    const request = withoutOrigin(continueRequest(1, conversationId))
    void first.service.execute(request, MAC_A_PEER)
    await vi.waitFor(() =>
      expect(
        first.service.operation({ operationId: fixtureOperationId(1), conversationId })
      ).toMatchObject({
        operation: { state: 'admitted' }
      })
    )
    // Crash: that process never runs again.
    const restarted = await startedHost('runtime-2', ['runtime-1'])
    const replay = operationOf(await restarted.service.execute(request, MAC_A_PEER))
    expect(replay).toMatchObject({ state: 'refused', refusal: { code: 'reconciling' } })
    await adoptTestConversation(restarted.service)
    const fresh = operationOf(
      await restarted.service.execute(withoutOrigin(continueRequest(2, conversationId)), MAC_A_PEER)
    )
    expect(fresh.state).toBe('completed')
    expect([...first.executor.dispatched, ...restarted.executor.dispatched]).toEqual([
      fixtureOperationId(2)
    ])
  })

  it('after dispatch, before the record: unconfirmed, never resent, and it fences the conversation until reconciled', async () => {
    const first = await startedHost('runtime-1')
    const { conversationId } = await adoptTestConversation(first.service)
    first.executor.afterDispatch = () => new Promise<never>(() => {})
    const request = withoutOrigin(continueRequest(1, conversationId))
    void first.service.execute(request, MAC_A_PEER)
    await vi.waitFor(() => expect(first.executor.dispatched).toHaveLength(1))

    const restarted = await startedHost('runtime-2', ['runtime-1'])
    await adoptTestConversation(restarted.service)
    const replay = operationOf(await restarted.service.execute(request, MAC_A_PEER))
    expect(replay.state).toBe('unconfirmed')
    // Another Mac, even after the turn moved on, cannot take the conversation while it is unknowable.
    restarted.executor.turn = 'turn:2'
    const other = operationOf(
      await restarted.service.execute(
        withoutOrigin(
          continueRequest(2, conversationId, { expectedTurnRevision: 'turn:2', origin: MAC_B })
        ),
        MAC_B_PEER
      )
    )
    expect(other.refusal).toMatchObject({
      code: 'turn-reserved',
      current: { operationId: fixtureOperationId(1) }
    })
    expect(first.executor.dispatched.length + restarted.executor.dispatched.length).toBe(1)

    await reconcileSessionHostOperation(restarted.service.store, fixtureOperationId(1), {
      delivered: true,
      note: 'the agent answered it'
    })
    const after = operationOf(
      await restarted.service.execute(
        withoutOrigin(continueRequest(3, conversationId, { expectedTurnRevision: 'turn:2' })),
        MAC_B_PEER
      )
    )
    expect(after.state).toBe('completed')
  })

  it('when dispatch cannot be recorded, nothing is sent and the turn is freed', async () => {
    const { executor, service } = await startedHost()
    const { conversationId } = await adoptTestConversation(service)
    vi.spyOn(service.store, 'markDispatched').mockRejectedValueOnce(
      new SessionHostStorageError('The disk is full.')
    )
    const failed = operationOf(
      await service.execute(withoutOrigin(continueRequest(1, conversationId)), MAC_A_PEER)
    )
    expect(failed).toMatchObject({ state: 'refused', refusal: { code: 'storage-unavailable' } })
    expect(executor.dispatched).toEqual([])
    const next = await service.execute(
      withoutOrigin(continueRequest(2, conversationId)),
      MAC_A_PEER
    )
    expect(operationOf(next).state).toBe('completed')
  })

  it('a live process is never reconciled from under itself', async () => {
    const first = await startedHost('runtime-1')
    const { conversationId } = await adoptTestConversation(first.service)
    first.executor.afterDispatch = () => new Promise<never>(() => {})
    void first.service.execute(withoutOrigin(continueRequest(1, conversationId)), MAC_A_PEER)
    await vi.waitFor(() => expect(first.executor.dispatched).toHaveLength(1))
    // A second profile opens the same registry while runtime-1 is alive: nothing is touched.
    const sibling = await startedHost('runtime-2')
    expect(
      sibling.service.operation({ operationId: fixtureOperationId(1), conversationId })
    ).toMatchObject({
      operation: { state: 'dispatched' }
    })
    const refused = await sibling.service.execute(
      withoutOrigin(continueRequest(2, conversationId)),
      MAC_B_PEER
    )
    expect(operationOf(refused).refusal?.code).toBe('ownership-conflict')
  })
})

describe('an archive and the turn it was admitted on', () => {
  it('a finished archive leaves the turn free, so the same turn can still be continued', async () => {
    const { executor, service } = await startedHost()
    const { conversationId } = await adoptTestConversation(service)
    const archived = await service.execute(
      withoutOrigin(archiveRequest(1, conversationId)),
      MAC_A_PEER
    )
    expect(operationOf(archived).state).toBe('completed')
    // The archive sent the conversation nothing, so the turn has not moved.
    const continued = await service.execute(
      withoutOrigin(continueRequest(2, conversationId)),
      MAC_A_PEER
    )
    expect(operationOf(continued).state).toBe('completed')
    expect(executor.dispatched).toEqual([fixtureOperationId(1), fixtureOperationId(2)])
  })

  it('a continuation that consumed the turn still refuses an archive read against it', async () => {
    const { executor, service } = await startedHost()
    const { conversationId } = await adoptTestConversation(service)
    const continued = await service.execute(
      withoutOrigin(continueRequest(1, conversationId)),
      MAC_A_PEER
    )
    expect(operationOf(continued).state).toBe('completed')
    const archived = await service.execute(
      withoutOrigin(archiveRequest(2, conversationId)),
      MAC_B_PEER
    )
    expect(operationOf(archived).refusal).toMatchObject({
      code: 'turn-reserved',
      current: { operationId: fixtureOperationId(1) }
    })
    expect(executor.dispatched).toEqual([fixtureOperationId(1)])
  })

  it('an archive an earlier build left settled does not hold the turn; a continuation does', async () => {
    const { service } = await startedHost()
    const registration = await adoptTestConversation(service)
    const journal = structuredClone(service.store.snapshot()!)
    const settled = (operationId: string, action: 'archive' | 'continue') => ({
      operationId,
      conversationId: registration.conversationId,
      hostId: journal.hostId,
      holder: 'remote:paired:mac-a',
      ownerEpoch: registration.ownerEpoch,
      turnRevision: 'turn:1',
      state: 'settled' as const,
      heldAt: 1,
      action,
      key: sessionHostTurnReservationKey(
        registration.conversationId,
        registration.ownerEpoch,
        'turn:1'
      )
    })
    journal.reservations['archive-op'] = settled('archive-op', 'archive')
    expect(sessionHostConversationHolder(journal, registration, 'turn:1')).toBeNull()
    journal.reservations['continue-op'] = settled('continue-op', 'continue')
    expect(sessionHostConversationHolder(journal, registration, 'turn:1')?.operationId).toBe(
      'continue-op'
    )
  })
})
