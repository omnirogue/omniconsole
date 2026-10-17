import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fixtureOperationId } from '../../shared/session-host-wire-fixtures'
import { SESSION_HOST_REQUEST_FIXTURES } from '../../shared/session-host-request-fixtures'
import type { SessionHostExecuteResult } from '../../shared/session-host-protocol'
import { evictSettledSessionHostOperations } from './session-host-reconcile'
import {
  consumeSessionHostGrant,
  registerSessionHostConversation,
  relinquishSessionHostConversation
} from './session-host-ownership-registry'
import {
  adoptTestConversation,
  continueRequest,
  FakeSessionHostExecutor,
  remote,
  TEST_NOW,
  testHostProcess,
  testHostRoot,
  withoutOrigin,
  type TestHostRoot
} from './session-host-test-fixture'

let roots: TestHostRoot[] = []
beforeEach(() => {
  roots = [testHostRoot(), testHostRoot()]
})
afterEach(() => {
  for (const root of roots) {
    root.dispose()
  }
})

const MAC_A = remote('paired:mac-a')
const MAC_B = remote('paired:mac-b')

async function hostOn(index: number, incarnation: string) {
  const executor = new FakeSessionHostExecutor()
  const service = await testHostProcess({
    root: roots[index]!.root,
    incarnation,
    executor
  }).service()
  return { executor, service }
}

function state(result: SessionHostExecuteResult) {
  return result.status === 'ok'
    ? [result.operation.state, result.operation.refusal?.code ?? null]
    : ['gate', result.refusal.code]
}

describe('the ownership registry', () => {
  it('mints one host id per execution account, shared by every profile and relay version', async () => {
    const [runtime, relay, other] = await Promise.all([
      hostOn(0, 'runtime-1'),
      hostOn(0, 'relay-9'),
      hostOn(1, 'runtime-1')
    ])
    expect(runtime.service.identity.hostId).toBe(relay.service.identity.hostId)
    expect(other.service.identity.hostId).not.toBe(runtime.service.identity.hostId)
  })

  it('keeps one registration per provider session and refuses to take it from a live process', async () => {
    const first = await hostOn(0, 'runtime-1')
    const a = await adoptTestConversation(first.service)
    expect((await adoptTestConversation(first.service)).conversationId).toBe(a.conversationId)
    const sibling = await hostOn(0, 'runtime-2')
    const taken = await registerSessionHostConversation(sibling.service.store, {
      provider: a.provider,
      binding: null,
      workspace: null,
      processIncarnation: null,
      adopted: true
    })
    expect(taken).toMatchObject({ status: 'refused', refusal: { code: 'ownership-conflict' } })
  })

  it('never loses one process’s write to another’s: the writer lock serializes the journal', async () => {
    const [one, two] = await Promise.all([hostOn(0, 'runtime-1'), hostOn(0, 'relay-1')])
    const registered = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        adoptTestConversation(index % 2 ? one.service : two.service, `session-${index}`)
      )
    )
    const journal = JSON.parse(readFileSync(join(roots[0]!.root, 'journal.json'), 'utf8'))
    expect(Object.keys(journal.conversations).sort()).toEqual(
      registered.map((entry) => entry.conversationId).sort()
    )
  })

  it('hands a conversation to exactly one destination, once, at the next epoch', async () => {
    const source = await hostOn(0, 'runtime-1')
    const destination = await hostOn(1, 'runtime-9')
    const { conversationId } = await adoptTestConversation(source.service)
    const relinquished = await relinquishSessionHostConversation(source.service.store, {
      conversationId,
      grantId: fixtureOperationId(17),
      relocation: fixtureOperationId(90),
      toHostId: destination.service.identity.hostId,
      manifestDigest: `sha256:${'a'.repeat(64)}`
    })
    if (relinquished.status !== 'ok') {
      throw new Error(relinquished.refusal.message)
    }
    expect(relinquished.grant).toMatchObject({
      ownerEpoch: 2,
      fromHostId: source.service.identity.hostId
    })
    // The source never acts on it again, whatever a Mac asks.
    expect(
      state(await source.service.execute(withoutOrigin(continueRequest(1, conversationId)), MAC_A))
    ).toEqual(['refused', 'not-owner'])
    const place = { binding: null, workspace: null, processIncarnation: null }
    const consumed = await consumeSessionHostGrant(
      destination.service.store,
      relinquished.grant,
      place
    )
    expect(consumed).toMatchObject({ status: 'ok', registration: { ownerEpoch: 2, owned: true } })
    // Replaying the same grant is idempotent; a forged one for the same id is refused.
    expect(
      await consumeSessionHostGrant(destination.service.store, relinquished.grant, place)
    ).toMatchObject({ status: 'ok' })
    expect(
      await consumeSessionHostGrant(
        destination.service.store,
        { ...relinquished.grant, manifestDigest: `sha256:${'b'.repeat(64)}` },
        place
      )
    ).toMatchObject({ status: 'refused', refusal: { code: 'grant-invalid' } })
    // A grant for another host is refused where it lands.
    expect(
      await consumeSessionHostGrant(source.service.store, relinquished.grant, place)
    ).toMatchObject({
      refusal: { code: 'grant-invalid' }
    })
    destination.executor.turn = 'turn:1'
    expect(
      state(
        await destination.service.execute(
          withoutOrigin(continueRequest(2, conversationId, { expectedOwnerEpoch: 2 })),
          MAC_A
        )
      )
    ).toEqual(['completed', null])
  })
})

describe('reservations', () => {
  it('a reservation holds the conversation for its holder only, and only a held one is released', async () => {
    const { executor, service } = await hostOn(0, 'runtime-1')
    const { conversationId } = await adoptTestConversation(service)
    const held = await service.reserve(
      withoutOrigin({
        ...SESSION_HOST_REQUEST_FIXTURES['transfer.prepare-source'],
        conversationId,
        expectedTurnRevision: 'turn:1'
      }),
      MAC_A
    )
    expect(state(held)).toEqual(['admitted', null])
    expect(
      state(await service.execute(withoutOrigin(continueRequest(2, conversationId)), MAC_B))
    ).toEqual(['refused', 'turn-reserved'])
    const settle = withoutOrigin({
      ...SESSION_HOST_REQUEST_FIXTURES['transfer.settle-source'],
      conversationId,
      expectedTurnRevision: 'turn:1',
      reservation: fixtureOperationId(11)
    })
    expect(state(await service.execute(settle, MAC_B))).toEqual(['refused', 'reservation-invalid'])
    const release = {
      operationId: fixtureOperationId(30),
      conversationId,
      reservation: fixtureOperationId(11)
    }
    expect(state(await service.release(release, MAC_B))).toEqual(['refused', 'reservation-invalid'])
    expect(
      state(await service.release({ ...release, operationId: fixtureOperationId(31) }, MAC_A))
    ).toEqual(['completed', null])
    expect(
      state(await service.execute(withoutOrigin(continueRequest(3, conversationId)), MAC_B))
    ).toEqual(['completed', null])
    expect(executor.dispatched).toEqual([fixtureOperationId(3)])
  })
})

describe('storage it cannot trust', () => {
  it('refuses to change a journal a newer build wrote, and leaves it byte for byte', async () => {
    const { service } = await hostOn(0, 'runtime-1')
    const { conversationId } = await adoptTestConversation(service)
    const path = join(roots[0]!.root, 'journal.json')
    const newer = JSON.stringify({
      ...JSON.parse(readFileSync(path, 'utf8')),
      v: 2,
      future: { kept: true }
    })
    writeFileSync(path, newer)
    const result = await service.execute(withoutOrigin(continueRequest(1, conversationId)), MAC_A)
    expect(result).toMatchObject({ status: 'refused', refusal: { code: 'storage-unavailable' } })
    expect(readFileSync(path, 'utf8')).toBe(newer)
  })

  it('refuses on a corrupt journal and preserves it as evidence', async () => {
    const { service } = await hostOn(0, 'runtime-1')
    const path = join(roots[0]!.root, 'journal.json')
    writeFileSync(path, '{"v":1,"hostId":')
    const result = await service.execute(
      withoutOrigin(continueRequest(1, 'conv_2437e543a0344939857f71286dd9b814')),
      MAC_A
    )
    expect(result).toMatchObject({ status: 'refused', refusal: { code: 'storage-unavailable' } })
    expect(readFileSync(path, 'utf8')).toBe('{"v":1,"hostId":')
  })

  it('evicts old settled operations but never lets an evicted id be admitted again', async () => {
    const { executor, service } = await hostOn(0, 'runtime-1')
    const { conversationId } = await adoptTestConversation(service)
    const request = withoutOrigin(continueRequest(1, conversationId))
    await service.execute(request, MAC_A)
    await service.store.mutate(async (journal) => ({
      value: undefined,
      changed: evictSettledSessionHostOperations(journal, TEST_NOW + 31 * 24 * 60 * 60 * 1000)
    }))
    expect(service.operation({ operationId: fixtureOperationId(1), conversationId })).toMatchObject(
      { status: 'refused', refusal: { code: 'invalid-request' } }
    )
    expect(await service.execute(request, MAC_A)).toMatchObject({
      status: 'refused',
      refusal: { code: 'invalid-request' }
    })
    // Its turn stays consumed: the newest settled reservation of a conversation is kept.
    expect(
      state(await service.execute(withoutOrigin(continueRequest(5, conversationId)), MAC_B))
    ).toEqual(['refused', 'turn-reserved'])
    expect(executor.dispatched).toEqual([fixtureOperationId(1)])
  })
})
