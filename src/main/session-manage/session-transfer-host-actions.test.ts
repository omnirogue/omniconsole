import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  SESSION_CONTROL_OWNER_CAPABILITY,
  SESSION_RELOCATION_CLAUDE_CAPABILITY,
  SESSION_RELOCATION_CODEX_CAPABILITY,
  SESSION_TRANSFER_REMOTE_SOURCE_CAPABILITY
} from '../../shared/session-host-capabilities'
import type { SessionHostRequest } from '../../shared/session-host-protocol'
import { fixtureOperationId } from '../../shared/session-host-wire-fixtures'
import { advertisableSessionHostCapabilities } from '../session-host/session-host-executor'
import { TEST_NOW } from '../session-host/session-host-test-fixture'
import {
  PERSON_ON_STUDIO,
  STEWARD_ON_STUDIO,
  type TestComputer
} from './session-transfer-host-fixture'
import { restartTestComputer, testComputer, testPort } from './session-transfer-port-fixture'
import { relocateConversation } from './session-transfer-relocate'
import { SAME_DISK_RELOCATION_CHANNEL } from './session-transfer-relocate-channel'
import { memorySessionRelocationRecords } from './session-transfer-relocate-record'

const CLAUDE_ID = '5b1f0c1e-7d7c-4c0e-9a55-0f1f2e3d4c5b'

let studio: TestComputer
let laptop: TestComputer
let disposers: (() => void)[] = []
let minted = 9_000
const next = () => fixtureOperationId(minted++)

beforeEach(async () => {
  const a = await testComputer('Studio')
  const b = await testComputer('Laptop')
  studio = a.computer
  laptop = b.computer
  disposers = [a.dispose, b.dispose]
})
afterEach(() => {
  for (const dispose of disposers) {
    dispose()
  }
})

function request<A extends SessionHostRequest['action']>(
  conversationId: string,
  action: A,
  payload: Extract<SessionHostRequest, { action: A }>['payload'],
  extra: Partial<SessionHostRequest> = {}
): SessionHostRequest {
  return {
    operationId: next(),
    conversationId,
    expectedOwnerEpoch: 1,
    expectedTurnRevision: 'turn:1',
    origin: PERSON_ON_STUDIO,
    action,
    payload,
    ...extra
  } as SessionHostRequest
}

function outcome(reply: Awaited<ReturnType<ReturnType<typeof testPort>['execute']>>) {
  return reply.status === 'ok'
    ? [reply.operation.state, reply.operation.refusal?.code ?? null, reply.operation.result]
    : ['gate', reply.refusal.code, null]
}

describe('what a host advertises', () => {
  it('advertises relocation per provider only while it is on, beside the remote-source transfer', () => {
    const owner = {
      ...studio,
      capabilities: () => [SESSION_CONTROL_OWNER_CAPABILITY, ...studio.actions().capabilities()],
      tidy: async () => undefined as never,
      history: async () => undefined as never
    }
    const on = advertisableSessionHostCapabilities(owner as never)
    expect(on).toEqual(
      expect.arrayContaining([
        SESSION_TRANSFER_REMOTE_SOURCE_CAPABILITY,
        SESSION_RELOCATION_CLAUDE_CAPABILITY,
        SESSION_RELOCATION_CODEX_CAPABILITY
      ])
    )
    studio.relocationOn = false
    expect(studio.actions().capabilities()).toEqual([SESSION_TRANSFER_REMOTE_SOURCE_CAPABILITY])
  })

  it('refuses every transfer and relocation step to an unattended caller, whatever it asks', async () => {
    const conversation = await studio.conversation('claude', CLAUDE_ID)
    const port = testPort(studio)
    const freeze = await port.execute(
      request(
        conversation.conversationId,
        'relocate.freeze-source',
        {
          relocation: next(),
          provider: 'claude',
          destination: { hostId: laptop.service.identity.hostId }
        },
        { origin: STEWARD_ON_STUDIO }
      )
    )
    expect(outcome(freeze).slice(0, 2)).toEqual(['refused', 'unattended-restricted'])
    const brief = await port.execute(
      request(
        conversation.conversationId,
        'transfer.prepare-source',
        { transfer: next(), mode: 'handoff', target: { hostId: laptop.service.identity.hostId } },
        { origin: STEWARD_ON_STUDIO }
      )
    )
    expect(outcome(brief).slice(0, 2)).toEqual(['refused', 'unattended-restricted'])
    expect(studio.frozen.size + studio.delivered.length).toBe(0)
  })
})

describe('a transfer source on its own host', () => {
  it('gives its brief under the reservation, stays fenced, then archives once the target accepted', async () => {
    const conversation = await studio.conversation('claude', CLAUDE_ID)
    const port = testPort(studio)
    const transfer = next()
    const target = {
      hostId: laptop.service.identity.hostId,
      conversationId: conversation.conversationId
    }
    const reserve = request(conversation.conversationId, 'transfer.prepare-source', {
      transfer,
      mode: 'handoff',
      target
    })
    const reserved = await port.reserve(reserve)
    expect(reserved.status === 'ok' && reserved.operation.state).toBe('admitted')
    const brief = await port.execute({
      ...request(conversation.conversationId, 'transfer.prepare-source', {
        transfer,
        mode: 'handoff',
        target
      }),
      reservation: reserve.operationId
    })
    expect(outcome(brief)).toEqual([
      'completed',
      null,
      { transfer, brief: `Brief of ${conversation.conversationId}`, checkpoint: 'turn:2' }
    ])
    expect(studio.delivered[0]).toMatch(/^\[from person on Studio\] Write a handoff/)
    // Fenced: a continue from anyone else is refused while the transfer holds it.
    const other = await testPort(studio, 'paired:another-mac').execute(
      request(
        conversation.conversationId,
        'continue',
        { answer: { kind: 'prompt', text: 'Go on.' } },
        { expectedTurnRevision: 'turn:2' }
      )
    )
    expect(outcome(other).slice(0, 2)).toEqual(['refused', 'turn-reserved'])
    const settled = await port.execute({
      ...request(
        conversation.conversationId,
        'transfer.settle-source',
        { transfer, outcome: 'accepted', targetReceipt: { ...target, operationId: next() } },
        { expectedTurnRevision: 'turn:2' }
      ),
      reservation: reserve.operationId
    })
    expect(outcome(settled).slice(0, 2)).toEqual(['completed', null])
    expect(studio.archived).toHaveLength(1)
    expect(studio.archived[0]!.reason).toMatch(/^handed off \(transfer /)
  })

  it('releases the source unarchived when the transfer is abandoned', async () => {
    const conversation = await studio.conversation('claude', CLAUDE_ID)
    const port = testPort(studio)
    const transfer = next()
    const target = { hostId: laptop.service.identity.hostId }
    const reserve = request(conversation.conversationId, 'transfer.prepare-source', {
      transfer,
      mode: 'consolidate',
      target
    })
    await port.reserve(reserve)
    const settled = await port.execute({
      ...request(conversation.conversationId, 'transfer.settle-source', {
        transfer,
        outcome: 'abandoned'
      }),
      reservation: reserve.operationId
    })
    expect(outcome(settled).slice(0, 2)).toEqual(['completed', null])
    expect(studio.archived).toEqual([])
    const observed = await port.observe({ conversationIds: [conversation.conversationId] })
    expect(observed.status === 'ok' && observed.sessions[0]?.admission).toBe('open')
  })

  it('refuses to archive a source that gave no brief for that transfer', async () => {
    const conversation = await studio.conversation('claude', CLAUDE_ID)
    const port = testPort(studio)
    const transfer = next()
    const reserve = request(conversation.conversationId, 'transfer.prepare-source', {
      transfer,
      mode: 'handoff',
      target: { hostId: laptop.service.identity.hostId }
    })
    await port.reserve(reserve)
    const settled = await port.execute({
      ...request(conversation.conversationId, 'transfer.settle-source', {
        transfer,
        outcome: 'accepted',
        targetReceipt: {
          hostId: laptop.service.identity.hostId,
          conversationId: conversation.conversationId,
          operationId: next()
        }
      }),
      reservation: reserve.operationId
    })
    expect(outcome(settled).slice(0, 2)).toEqual(['refused', 'not-eligible'])
    expect(studio.archived).toEqual([])
  })
})

describe('the grant is used once', () => {
  it('lets only the resuming operation that consumed the grant use it', async () => {
    const conversation = await studio.conversation('claude', CLAUDE_ID)
    const records = memorySessionRelocationRecords()
    const destination = testPort(laptop)
    let clock = 0
    const result = await relocateConversation(
      {
        source: testPort(studio),
        destination,
        channel: SAME_DISK_RELOCATION_CHANNEL,
        records,
        relocationEnabled: () => true,
        mintOperationId: next,
        now: () => TEST_NOW,
        step: { waitMs: 40, pollMs: 1, sleep: async () => {}, now: () => (clock += 10) }
      },
      {
        conversationId: conversation.conversationId,
        origin: PERSON_ON_STUDIO,
        workspace: { kind: 'folder', path: '/work/Laptop' },
        providerVersion: '2.1.0',
        dryRun: false
      }
    )
    expect(result.outcome).toBe('relocated')
    const grant = records.records.get(result.relocation!)!.grant!
    const again = await destination.execute(
      request(
        conversation.conversationId,
        'relocate.resume',
        { relocation: grant.relocation, provider: 'claude', grant },
        { expectedOwnerEpoch: 3, expectedTurnRevision: null }
      )
    )
    expect(outcome(again).slice(0, 2)).toEqual(['refused', 'grant-invalid'])
    const stale = await destination.execute(
      request(
        conversation.conversationId,
        'relocate.resume',
        { relocation: grant.relocation, provider: 'claude', grant },
        { expectedOwnerEpoch: 2, expectedTurnRevision: null }
      )
    )
    expect(outcome(stale).slice(0, 2)).toEqual(['refused', 'stale-owner-epoch'])
    expect(laptop.launched).toHaveLength(1)
  })
})

describe('a crash while relinquishing', () => {
  it('is reconciled from the journal: the issued grant is recovered and the move finishes once', async () => {
    const conversation = await studio.conversation('claude', CLAUDE_ID)
    studio.retireHangs = true
    const records = memorySessionRelocationRecords()
    const source = testPort(studio)
    let clock = 0
    const deps = {
      source,
      destination: testPort(laptop),
      channel: SAME_DISK_RELOCATION_CHANNEL,
      records,
      relocationEnabled: () => true,
      mintOperationId: next,
      now: () => TEST_NOW,
      step: { waitMs: 40, pollMs: 1, sleep: async () => {}, now: () => (clock += 10) }
    }
    const input = {
      conversationId: conversation.conversationId,
      origin: PERSON_ON_STUDIO,
      workspace: { kind: 'folder' as const, path: '/work/Laptop' },
      providerVersion: '2.1.0',
      dryRun: false
    }
    // The relinquishment is written, then the process hangs forever: the reply never comes.
    void relocateConversation(deps, input)
    for (let tries = 0; tries < 200 && studio.retired.length === 0; tries += 1) {
      await new Promise((done) => setTimeout(done, 10))
    }
    expect(studio.retired).toEqual([conversation.conversationId])
    const relocation = [...records.records.keys()][0]!

    const restarted = await restartTestComputer(studio, 'Studio-2', 'Studio-1')
    const relinquish = () =>
      Object.values(restarted.service.store.snapshot()!.operations).find(
        (operation) => operation.action === 'relocate.relinquish'
      )!
    expect(relinquish().state).toBe('unconfirmed')
    await restarted.actions().reconcile()
    expect(relinquish()).toMatchObject({ state: 'completed', result: { relinquished: true } })

    const finished = await relocateConversation(
      { ...deps, source: testPort(restarted) },
      { ...input, relocation }
    )
    expect(finished.outcome).toBe('relocated')
    expect(laptop.launched).toHaveLength(1)
  })
})
