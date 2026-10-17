import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sessionHostPromptMarker } from '../../shared/session-host-authority'
import { fixtureOperationId } from '../../shared/session-host-wire-fixtures'
import {
  adoptTestConversation,
  continueRequest,
  MAC_A,
  MAC_B,
  remote,
  testHostRoot,
  withoutOrigin,
  type TestHostRoot
} from '../session-host/session-host-test-fixture'
import { configureStewardSwitches } from '../session-steward/steward-switches'
import { observeSources } from '../session-manage/session-manage-test-fixtures'
import { configureSessionHostSwitches } from './session-host-switches'
import {
  HOST_SESSION_ID,
  HOST_SOURCE,
  ownerTestHost,
  type OwnerTestHost
} from './session-host-owner-test-host'
import { sessionHostTurnRevision } from './session-host-turn'

let root: TestHostRoot
let host: OwnerTestHost
const restores: (() => void)[] = []

beforeEach(() => {
  root = testHostRoot()
  host = ownerTestHost({ root: root.root })
})
afterEach(async () => {
  // Why last first: each restore puts back what was there when it was installed.
  for (const restore of restores.splice(0).toReversed()) {
    restore()
  }
  await host.inventory.flush()
  root.dispose()
})

const TURN = sessionHostTurnRevision({
  known: true,
  turnKey: 't1',
  text: 'Done.',
  complete: true,
  proposal: null,
  empty: false
})

/** A free prompt that asks for work, not an approval (those are refused). */
function prompt(n: number, conversationId: string) {
  return continueRequest(n, conversationId, {
    expectedTurnRevision: TURN,
    payload: { answer: { kind: 'prompt', text: `Summarize what changed in the parser (${n}).` } }
  })
}

async function adopted() {
  const service = await host.process.service()
  const registration = await adoptTestConversation(service, HOST_SESSION_ID)
  // The fixture binds its own pane; this host's row is the one the inventory lists.
  await service.store.mutate(async (journal) => {
    journal.conversations[registration.conversationId]!.binding = HOST_SOURCE
    return { value: null, changed: true }
  })
  return { service, conversationId: registration.conversationId }
}

/** Runs an execute while the queue's drain sends what it queued, as the runtime would. */
async function executeDraining(
  run: () => Promise<Awaited<ReturnType<Awaited<ReturnType<typeof adopted>>['service']['execute']>>>
) {
  const pending = run()
  await vi
    .waitFor(() => expect(host.queue.size).toBeGreaterThan(0), { timeout: 2_000 })
    .catch(() => {})
  await host.drain()
  return await pending
}

describe('a paired host carries out another computer’s controls', () => {
  it('continues with the other computer’s marker, through the queue and the send door, with no window', async () => {
    const { service, conversationId } = await adopted()
    host.window.attached = true
    await host.executor.observe([])
    host.window.attached = false
    const request = prompt(1, conversationId)
    const result = await executeDraining(() =>
      service.execute(withoutOrigin(request), remote('mac-a', MAC_A))
    )
    expect(result).toMatchObject({ status: 'ok', operation: { state: 'completed' } })
    const [entry] = [...host.queue.values()]
    expect(entry!.text.startsWith(sessionHostPromptMarker(remote('mac-a', MAC_A)))).toBe(true)
    expect(entry!.text).toContain('Summarize what changed in the parser (1).')
    expect(entry).toMatchObject({
      state: 'delivered',
      requestedBy: { hostOperation: { operationId: request.operationId, conversationId } }
    })
  })

  it('two Macs with different ids for the same idle turn: one continuation', async () => {
    const { service, conversationId } = await adopted()
    const first = await executeDraining(() =>
      service.execute(withoutOrigin(prompt(1, conversationId)), remote('mac-a', MAC_A))
    )
    const second = await service.execute(
      withoutOrigin(prompt(2, conversationId)),
      remote('mac-b', MAC_B)
    )
    expect(first).toMatchObject({ operation: { state: 'completed' } })
    expect(second).toMatchObject({
      operation: { state: 'refused', refusal: { code: 'turn-reserved' } }
    })
    expect(host.queue.size).toBe(1)
  })
})

describe('hard stops, unattended rules and drivers survive forwarding', () => {
  it('refuses a hard stop from another computer and queues nothing', async () => {
    const { service, conversationId } = await adopted()
    const request = continueRequest(1, conversationId, {
      expectedTurnRevision: TURN,
      payload: { answer: { kind: 'prompt', text: 'helm upgrade api ./chart' } }
    })
    const result = await service.execute(withoutOrigin(request), remote('mac-a', MAC_A))
    expect(result).toMatchObject({
      operation: { state: 'refused', refusal: { code: 'hard-stop' } }
    })
    expect(host.queue.size).toBe(0)
  })

  it('an unattended caller on another computer may not stop a session here', async () => {
    const { service, conversationId } = await adopted()
    const origin = {
      computer: 'Studio',
      requester: { kind: 'cli' as const, unattended: { source: 'rules' as const } }
    }
    const result = await service.execute(
      {
        operationId: fixtureOperationId(3),
        conversationId,
        expectedOwnerEpoch: 1,
        expectedTurnRevision: null,
        action: 'stop',
        payload: {}
      },
      remote('mac-a', origin)
    )
    expect(result).toMatchObject({
      operation: { state: 'refused', refusal: { code: 'unattended-restricted' } }
    })
  })

  it('an unattended caller never prompts a session Keep going drives', async () => {
    const { service, conversationId } = await adopted()
    host.sources.current = observeSources({ keepGoing: () => true })
    const origin = {
      computer: 'Studio',
      requester: { kind: 'cli' as const, unattended: { source: 'rules' as const } }
    }
    const result = await service.execute(
      withoutOrigin(prompt(4, conversationId)),
      remote('mac-a', origin)
    )
    expect(result).toMatchObject({
      operation: { state: 'refused', refusal: { code: 'has-driver' } }
    })
    expect(host.queue.size).toBe(0)
  })

  it('this computer’s switches decide: steward off, or a folder that admits no automation', async () => {
    const { service, conversationId } = await adopted()
    const origin = {
      computer: 'Studio',
      requester: { kind: 'cli' as const, unattended: { source: 'rules' as const } }
    }
    restores.push(configureStewardSwitches({ readSettings: () => ({ enabled: false }) }))
    const off = await service.execute(
      withoutOrigin(prompt(5, conversationId)),
      remote('mac-a', origin)
    )
    expect(off).toMatchObject({ operation: { refusal: { code: 'automation-disabled' } } })
    restores.pop()!()
    host.rows[0] = { ...host.rows[0]!, folderId: 'folder-ops' }
    restores.push(
      configureSessionHostSwitches({
        readSettings: () => ({ folderPolicies: { 'folder-ops': { automation: 'off' } } })
      })
    )
    const folder = await service.execute(
      withoutOrigin(prompt(6, conversationId)),
      remote('mac-a', origin)
    )
    expect(folder).toMatchObject({ operation: { refusal: { code: 'automation-disabled' } } })
    expect(host.queue.size).toBe(0)
  })

  it('advertises nothing while remote control is switched off here', async () => {
    expect(host.executor.capabilities()).toContain('session-control.owner.v1')
    restores.push(configureSessionHostSwitches({ readSettings: () => ({ remoteControls: false }) }))
    expect(host.executor.capabilities()).toEqual([])
    restores.push(
      configureSessionHostSwitches({ environment: { OMNI_SESSION_HOST_DISABLED: '1' } })
    )
    expect(host.executor.capabilities()).toEqual([])
  })
})

describe('what observe says about sessions this host cannot see', () => {
  it('a registration with no pane here now is unverifiable, never exited', async () => {
    const { service, conversationId } = await adopted()
    host.rows.splice(0)
    const observed = await host.executor.observe([
      service.store.snapshot()!.conversations[conversationId]!
    ])
    expect(observed.get(conversationId)).toEqual({ verdict: 'unverifiable', turnRevision: null })
  })

  it('a pane that now holds a newer conversation does not lend it to the earlier one', async () => {
    const { service, conversationId } = await adopted()
    host.rows[0]!.providerSessionId = 'claude-session-after-clear'
    const observed = await host.executor.observe([
      service.store.snapshot()!.conversations[conversationId]!
    ])
    expect(observed.get(conversationId)).toEqual({ verdict: 'unverifiable', turnRevision: null })
  })
})
