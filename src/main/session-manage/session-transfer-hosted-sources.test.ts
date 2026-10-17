import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fixtureOperationId } from '../../shared/session-host-wire-fixtures'
import { TEST_NOW } from '../session-host/session-host-test-fixture'
import type { AskWaitResult } from './session-manage-ask-wait'
import { consolidateSessions } from './session-manage-consolidate'
import { handoffSession } from './session-manage-handoff'
import type { SessionTransferInput } from './session-manage-transfer-contract'
import { transferFixture, transferSession } from './session-manage-transfer-fixtures'
import { PERSON_ON_STUDIO, type TestComputer } from './session-transfer-host-fixture'
import {
  HostTransferSources,
  type SessionTransferHostRecord
} from './session-transfer-host-sources'
import { testComputer, testPort } from './session-transfer-port-fixture'
import { memorySessionTransferRecords } from './session-transfer-record-files'
import { setSessionWaitRepointer } from './session-transfer-adoption'

const actor = { kind: 'pane' as const, paneKey: 'actor', title: 'Coordinator' }
const TARGET_HOST = 'host_0123456789abcdef0123456789abcdef'
const TARGET_CONVERSATION = 'conv_fedcba9876543210fedcba9876543210'

let studio: TestComputer
let laptop: TestComputer
let ports: Map<string, ReturnType<typeof testPort>>
let disposers: (() => void)[] = []
let records: ReturnType<typeof memorySessionTransferRecords<SessionTransferHostRecord>>
let minted = 20_000
const next = () => fixtureOperationId(minted++)

beforeEach(async () => {
  const a = await testComputer('Studio')
  const b = await testComputer('Laptop')
  studio = a.computer
  laptop = b.computer
  disposers = [a.dispose, b.dispose]
  ports = new Map([
    [studio.service.identity.hostId, testPort(studio)],
    [laptop.service.identity.hostId, testPort(laptop)]
  ])
  records = memorySessionTransferRecords<SessionTransferHostRecord>((record) => record.transfer)
})
afterEach(() => {
  for (const dispose of disposers) {
    dispose()
  }
})

function portOf(computer: TestComputer) {
  return ports.get(computer.service.identity.hostId)!
}

function hostedDeps() {
  let clock = 0
  return {
    records,
    mintOperationId: next,
    now: () => TEST_NOW,
    step: { waitMs: 40, pollMs: 1, sleep: async () => {}, now: () => (clock += 10) },
    origin: PERSON_ON_STUDIO,
    targetHostId: async () => TARGET_HOST,
    targetConversationId: async () => TARGET_CONVERSATION
  }
}

async function hostedSource(computer: TestComputer, sessionId: string) {
  const registration = await computer.conversation('claude', sessionId)
  return {
    port: portOf(computer),
    conversationId: registration.conversationId,
    title: `work ${sessionId}`
  }
}

function briefsAsked(computer: TestComputer): number {
  return computer.delivered.filter((line) => line.includes('Answer only; change nothing.')).length
}

async function admission(computer: TestComputer, conversationId: string) {
  const observed = await portOf(computer).observe({ conversationIds: [conversationId] })
  const row = observed.status === 'ok' ? observed.sessions[0] : undefined
  return [row?.admission, row?.reservation?.action ?? null]
}

describe('a handoff from a session on another computer', () => {
  it('asks the brief there, delivers it here, and has that computer archive it after acceptance', async () => {
    const { deps, target } = transferFixture()
    const source = await hostedSource(studio, 'studio-1')
    studio.briefs.set(source.conversationId, 'Goal: ship the parser. Next: fix syntax.')
    const input: SessionTransferInput = {
      actor,
      sources: [],
      hostSources: [source],
      target,
      dryRun: false
    }
    const result = await handoffSession({ ...deps, hosted: hostedDeps() }, input)

    expect(result.outcome).toBe('completed')
    expect(deps.ask).not.toHaveBeenCalled()
    const brief = deps.deliver.mock.calls[0]![1]
    expect(brief).toContain('from session “work studio-1 (on Studio)”')
    expect(brief).toContain('Goal: ship the parser.')
    expect(result.hostSources).toEqual([
      expect.objectContaining({
        label: 'Studio',
        conversationId: source.conversationId,
        state: 'archived'
      })
    ])
    expect(result.archived).toEqual([{ paneKey: null, title: 'work studio-1 (on Studio)' }])
    expect(studio.archived).toEqual([
      {
        conversationId: source.conversationId,
        reason: expect.stringContaining(TARGET_CONVERSATION)
      }
    ])
    expect(briefsAsked(studio)).toBe(1)
    // The archive settled its reservation; nothing is left holding the conversation.
    expect((await admission(studio, source.conversationId))[1]).toBeNull()
  })

  it('releases every hosted source untouched when the target never accepts', async () => {
    const { deps, target } = transferFixture()
    deps.deliver.mockImplementationOnce(async () => ({
      sent: 'brief',
      acknowledgement: 'Accepted transfer fixture',
      wait: Promise.resolve<AskWaitResult>({ outcome: 'answered', reply: 'I cannot take this.' })
    }))
    const source = await hostedSource(studio, 'studio-1')
    const result = await handoffSession(
      { ...deps, hosted: hostedDeps() },
      { actor, sources: [], hostSources: [source], target, dryRun: false }
    )
    expect(result.outcome).toBe('failed')
    expect(result.hostSources).toEqual([expect.objectContaining({ state: 'released' })])
    expect(studio.archived).toEqual([])
    expect(await admission(studio, source.conversationId)).toEqual(['open', null])
  })

  it('sends no brief when the source changed after giving it', async () => {
    const { deps, target } = transferFixture()
    const source = await hostedSource(studio, 'studio-1')
    deps.assertCheckpoints.mockImplementation(() => {
      // A person typed into it on its own computer after it gave its brief.
      studio.turns.set(source.conversationId, 'turn:9')
    })
    const result = await handoffSession(
      { ...deps, hosted: hostedDeps() },
      { actor, sources: [], hostSources: [source], target, dryRun: false }
    )
    expect(result.outcome).toBe('failed')
    expect(result.failure).toMatch(/changed since its brief/)
    expect(deps.deliver).not.toHaveBeenCalled()
    expect(result.hostSources).toEqual([
      expect.objectContaining({ state: expect.stringMatching(/released|unresolved/) })
    ])
    expect(studio.archived).toEqual([])
  })
})

describe('a source this computer’s own session host adopted', () => {
  it('is reserved and archived through that host, and still seeds a new target', async () => {
    const { deps } = transferFixture()
    const here = transferSession('adopted-pane')
    const hosted = await hostedSource(studio, 'studio-1')
    const result = await handoffSession(
      {
        ...deps,
        hosted: {
          ...hostedDeps(),
          hostedFor: async (session) => (session === here ? hosted : null)
        }
      },
      { actor, sources: [here], target: 'new', dryRun: false }
    )
    expect(result.outcome).toBe('completed')
    expect(deps.ask).not.toHaveBeenCalled()
    expect(deps.create).toHaveBeenCalledWith(here, 'work studio-1 (continued)')
    expect(deps.file).toHaveBeenCalledWith(expect.anything(), here)
    expect(deps.archive).not.toHaveBeenCalled()
    expect(result.hostSources).toEqual([expect.objectContaining({ state: 'archived' })])
    expect(result.archived).toEqual([{ paneKey: 'adopted-pane', title: 'work studio-1' }])
    expect(briefsAsked(studio)).toBe(1)
  })

  it('archives nothing at the host when adopting the source’s waits fails after acceptance', async () => {
    const { deps, target } = transferFixture()
    const here = transferSession('adopted-pane')
    const hosted = await hostedSource(studio, 'studio-1')
    const restore = setSessionWaitRepointer(async () => {
      throw new Error('the waiter’s outcome set moved on')
    })
    try {
      const result = await handoffSession(
        {
          ...deps,
          hosted: {
            ...hostedDeps(),
            hostedFor: async (session) => (session === here ? hosted : null)
          }
        },
        { actor, sources: [here], target, dryRun: false }
      )
      expect([result.outcome, result.failedStep]).toEqual(['failed', 'adopt unfinished work'])
      expect(result.hostSources).toEqual([expect.objectContaining({ state: 'released' })])
      expect(studio.archived).toEqual([])
    } finally {
      restore()
    }
  })

  it('stays on the existing path when its host does not carry transfers', async () => {
    const { deps } = transferFixture()
    const here = transferSession('plain-pane')
    const result = await handoffSession(
      { ...deps, hosted: { ...hostedDeps(), hostedFor: async () => null } },
      { actor, sources: [here], target: 'new', dryRun: false }
    )
    expect(result.outcome).toBe('completed')
    expect(deps.ask).toHaveBeenCalledTimes(1)
    expect(deps.archive).toHaveBeenCalledWith(
      [here],
      expect.any(String),
      expect.any(Function),
      expect.anything()
    )
    expect(result.hostSources).toBeUndefined()
  })
})

describe('a consolidation across computers survives partial failure', () => {
  it('archives what its host confirmed, leaves an unreachable source untouched, and finishes it later without asking again', async () => {
    const { deps, target } = transferFixture()
    const here = transferSession('local-source')
    const onStudio = await hostedSource(studio, 'studio-1')
    const onLaptop = await hostedSource(laptop, 'laptop-1')
    const laptopPort = portOf(laptop)
    const deliver = deps.deliver.getMockImplementation()!
    deps.deliver.mockImplementationOnce(async (...args) => {
      laptopPort.faults.down = true
      return await deliver(...args)
    })
    const result = await consolidateSessions(
      { ...deps, hosted: hostedDeps() },
      { actor, sources: [here], hostSources: [onStudio, onLaptop], target, dryRun: false }
    )
    expect(result.outcome).toBe('completed')
    expect(deps.archive).toHaveBeenCalledWith(
      [here],
      expect.any(String),
      expect.any(Function),
      expect.anything()
    )
    const states = Object.fromEntries(
      result.hostSources!.map((receipt) => [receipt.label, receipt.state])
    )
    expect(states).toEqual({ Studio: 'archived', Laptop: 'unresolved' })
    expect(result.summary).toMatch(new RegExp(`Continue transfer ${result.transfer}`))
    expect(laptop.archived).toEqual([])

    laptopPort.faults.down = false
    const resumed = await HostTransferSources.resume(
      hostedDeps(),
      result.transfer!,
      (hostId) => ports.get(hostId) ?? null
    )
    const receipts = await resumed!.settle('accepted')
    expect(Object.fromEntries(receipts.map((receipt) => [receipt.label, receipt.state]))).toEqual({
      Studio: 'archived',
      Laptop: 'archived'
    })
    expect(laptop.archived).toHaveLength(1)
    expect(studio.archived).toHaveLength(1)
    expect([briefsAsked(studio), briefsAsked(laptop)]).toEqual([1, 1])
  })

  it('reserves in canonical host order and asks nobody when a later reservation conflicts', async () => {
    const { deps, target } = transferFixture()
    const onStudio = await hostedSource(studio, 'studio-1')
    const onLaptop = await hostedSource(laptop, 'laptop-1')
    const [first, second] = [onStudio, onLaptop].sort((a, b) =>
      a.port.hostId.localeCompare(b.port.hostId)
    )
    // Another Mac holds the second one's turn.
    await testPort(second!.port === portOf(studio) ? studio : laptop, 'paired:another-mac').reserve(
      {
        operationId: next(),
        conversationId: second!.conversationId,
        expectedOwnerEpoch: 1,
        expectedTurnRevision: 'turn:1',
        origin: PERSON_ON_STUDIO,
        action: 'continue',
        payload: { answer: { kind: 'prompt', text: 'mine' } }
      }
    )
    const result = await consolidateSessions(
      { ...deps, hosted: hostedDeps() },
      { actor, sources: [], hostSources: [onLaptop, onStudio], target, dryRun: false }
    )
    expect(result.outcome).toBe('failed')
    expect(result.failure).toMatch(/could not be reserved/)
    expect(briefsAsked(studio) + briefsAsked(laptop)).toBe(0)
    const firstHost = first!.port === portOf(studio) ? studio : laptop
    expect(await admission(firstHost, first!.conversationId)).toEqual(['open', null])
    expect(
      result.hostSources!.find((receipt) => receipt.conversationId === first!.conversationId)?.state
    ).toBe('released')
  })

  it('skips a busy source on another computer with skip-busy and goes on with the rest', async () => {
    const { deps, target } = transferFixture()
    const here = transferSession('local-source')
    const onStudio = await hostedSource(studio, 'studio-1')
    const onLaptop = await hostedSource(laptop, 'laptop-1')
    await testPort(laptop, 'paired:another-mac').reserve({
      operationId: next(),
      conversationId: onLaptop.conversationId,
      expectedOwnerEpoch: 1,
      expectedTurnRevision: 'turn:1',
      origin: PERSON_ON_STUDIO,
      action: 'continue',
      payload: { answer: { kind: 'prompt', text: 'mine' } }
    })
    const result = await consolidateSessions(
      { ...deps, hosted: hostedDeps() },
      {
        actor,
        sources: [here],
        hostSources: [onStudio, onLaptop],
        target,
        dryRun: false,
        skipBusy: true
      }
    )
    expect([result.outcome, result.failure]).toEqual(['completed', undefined])
    expect(result.skipped).toEqual([
      expect.objectContaining({ title: 'work laptop-1 (on Laptop)' })
    ])
    expect(
      Object.fromEntries(result.hostSources!.map((receipt) => [receipt.label, receipt.state]))
    ).toEqual({
      Studio: 'archived',
      Laptop: 'released'
    })
    expect(briefsAsked(laptop)).toBe(0)
    expect(laptop.archived).toEqual([])
  })

  it('reads a lost brief reply from its host instead of asking again', async () => {
    const { deps, target } = transferFixture()
    const source = await hostedSource(studio, 'studio-1')
    portOf(studio).faults.dropReplyOf.add('transfer.prepare-source')
    const result = await handoffSession(
      { ...deps, hosted: hostedDeps() },
      { actor, sources: [], hostSources: [source], target, dryRun: false }
    )
    expect(result.outcome).toBe('completed')
    expect(briefsAsked(studio)).toBe(1)
    expect(result.hostSources).toEqual([expect.objectContaining({ state: 'archived' })])
  })
})
