import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PromptQueueEntry } from '../../shared/prompt-queue-types'
import { deliverUnderSessionHostAdmission } from '../session-host/session-host-delivery-admission'
import {
  adoptTestConversation,
  continueRequest,
  FakeSessionHostExecutor,
  remote,
  testHostProcess,
  testHostRoot,
  withoutOrigin,
  type TestHostRoot
} from '../session-host/session-host-test-fixture'
import type { SessionHostService } from '../session-host/session-host-service'
import { adoptHostSessions } from './host-session-adoption'
import { reconcileHostDeliveries } from './session-host-owner-reconcile'
import {
  HOST_SESSION_ID,
  HOST_SOURCE,
  ownerTestHost,
  type OwnerTestHost
} from './session-host-owner-test-host'

let root: TestHostRoot
const hosts: OwnerTestHost[] = []
beforeEach(() => {
  root = testHostRoot()
})
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.inventory.flush()))
  root.dispose()
})

function testHost(input: Parameters<typeof ownerTestHost>[0]): OwnerTestHost {
  const host = ownerTestHost(input)
  hosts.push(host)
  return host
}

async function bindToHostPane(service: SessionHostService, conversationId: string) {
  await service.store.mutate(async (journal) => {
    journal.conversations[conversationId]!.binding = HOST_SOURCE
    return { value: null, changed: true }
  })
}

/** A process that admitted a continue, recorded its dispatch, and died before it settled. */
async function crashedContinue() {
  const crashed = new FakeSessionHostExecutor()
  crashed.afterDispatch = () => new Promise(() => {})
  const first = testHostProcess({ root: root.root, incarnation: 'runtime-1', executor: crashed })
  const service = await first.service()
  const { conversationId } = await adoptTestConversation(service, HOST_SESSION_ID)
  await bindToHostPane(service, conversationId)
  const request = continueRequest(1, conversationId)
  void service.execute(withoutOrigin(request), remote('mac-a'))
  await vi.waitFor(() => expect(crashed.dispatched).toHaveLength(1))
  const host = testHost({ root: root.root, incarnation: 'runtime-2', dead: ['runtime-1'] })
  const restarted = await host.process.service()
  return { host, service: restarted, operationId: request.operationId, conversationId }
}

function queued(
  state: PromptQueueEntry['state'],
  hostOperation: { operationId: string; conversationId: string },
  extra: Partial<PromptQueueEntry> = {}
): PromptQueueEntry {
  return {
    id: 'session-manage:1',
    text: '[from Release notes on Studio] Summarize.',
    createdAt: 1,
    state,
    requestedBy: { action: 'continue', actor: 'remote', hostOperation },
    ...extra
  }
}

describe('a restart reconciles a delivery instead of repeating it', () => {
  type HostOperation = { operationId: string; conversationId: string }
  const cases: [string, (operation: HostOperation) => PromptQueueEntry[], string][] = [
    ['delivered', (operation) => [queued('delivered', operation)], 'completed'],
    [
      'failed with proof nothing was sent',
      (operation) => [queued('failed', operation, { unsent: true })],
      'refused'
    ],
    ['still queued, so withdrawn now', (operation) => [queued('queued', operation)], 'refused'],
    ['never queued', () => [], 'refused']
  ]

  it.each(cases)('%s', async (_label, entriesOf, expected) => {
    const { host, service, operationId, conversationId } = await crashedContinue()
    expect(service.store.snapshot()!.operations[operationId]!.state).toBe('unconfirmed')
    const entries = entriesOf({ operationId, conversationId })
    await reconcileHostDeliveries(service, {
      readQueue: () => ({ source: HOST_SOURCE, entries }),
      withdraw: (_rowKey, entryId) =>
        entries.some((entry) => entry.id === entryId && entry.state === 'queued'),
      readTurn: (registration) => host.executor.readTurn(registration)
    })
    expect(service.store.snapshot()!.operations[operationId]!.state).toBe(expected)
  })

  it('a send that started stays unconfirmed until the conversation takes a new turn', async () => {
    const { service, operationId, conversationId } = await crashedContinue()
    const entries = [queued('sending', { operationId, conversationId }, { operationId: 'x' })]
    const deps = (turnRevision: string) => ({
      readQueue: () => ({ source: HOST_SOURCE, entries }),
      withdraw: () => false,
      readTurn: async () => ({ turnRevision, organizationRevision: null })
    })
    await reconcileHostDeliveries(service, deps('turn:1'))
    expect(service.store.snapshot()!.operations[operationId]!.state).toBe('unconfirmed')
    await reconcileHostDeliveries(service, deps('turn:2'))
    expect(service.store.snapshot()!.operations[operationId]!.state).toBe('completed')
  })
})

describe('adoption: only live, local conversations with a readable turn', () => {
  it('adopts a live pane whose agent holds it and whose turn reads; not one whose turn does not', async () => {
    const host = testHost({ root: root.root })
    const service = await host.process.service()
    const sessions = await host.inventory.list()
    await adoptHostSessions({ store: service.store, sessions, turnRevision: () => null })
    const [unadopted] = Object.values(service.store.snapshot()!.conversations)
    expect(unadopted).toMatchObject({ adopted: false, provider: { sessionId: HOST_SESSION_ID } })
    await adoptHostSessions({ store: service.store, sessions, turnRevision: () => 'turn:1' })
    const [adopted] = Object.values(service.store.snapshot()!.conversations)
    expect(adopted).toMatchObject({ adopted: true, conversationId: unadopted!.conversationId })
  })

  it('queued prompts to a conversation it did not adopt keep flowing through the send door', async () => {
    const host = testHost({ root: root.root })
    const service = await host.process.service()
    const sessions = await host.inventory.list()
    await adoptHostSessions({ store: service.store, sessions, turnRevision: () => null })
    const deliver = vi.fn(async () => ({ door: 'pty' as const, deliveredAt: 1 }))
    await deliverUnderSessionHostAdmission({
      host: host.process,
      source: HOST_SOURCE,
      text: 'The person’s own queued prompt.',
      operationId: 'prompt-queue:anything',
      deliver
    })
    expect(deliver).toHaveBeenCalledOnce()
  })

  it('writes nothing when nothing changed, and never re-registers a conversation moved away', async () => {
    const host = testHost({ root: root.root })
    const service = await host.process.service()
    const sessions = await host.inventory.list()
    await adoptHostSessions({ store: service.store, sessions, turnRevision: () => 'turn:1' })
    const mutate = vi.spyOn(service.store, 'mutate')
    await adoptHostSessions({ store: service.store, sessions, turnRevision: () => 'turn:1' })
    expect(mutate).not.toHaveBeenCalled()
    mutate.mockRestore()
    await service.store.mutate(async (journal) => {
      Object.values(journal.conversations)[0]!.owned = false
      return { value: null, changed: true }
    })
    const result = await adoptHostSessions({
      store: service.store,
      sessions,
      turnRevision: () => 'turn:1'
    })
    expect(result.registered).toBe(0)
    expect(Object.values(service.store.snapshot()!.conversations)).toHaveLength(1)
  })
})
