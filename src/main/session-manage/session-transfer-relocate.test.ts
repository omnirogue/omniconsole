import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionHostRequest } from '../../shared/session-host-protocol'
import { fixtureOperationId } from '../../shared/session-host-wire-fixtures'
import { encodeClaudeProjectPath } from '../ai-vault/claude-project-dir-encoding'
import { TEST_NOW } from '../session-host/session-host-test-fixture'
import {
  PERSON_ON_STUDIO,
  STEWARD_ON_STUDIO,
  type TestComputer
} from './session-transfer-host-fixture'
import { testComputer, testPort } from './session-transfer-port-fixture'
import { relocateConversation, type SessionRelocateDeps } from './session-transfer-relocate'
import { SAME_DISK_RELOCATION_CHANNEL } from './session-transfer-relocate-channel'
import { memorySessionRelocationRecords } from './session-transfer-relocate-record'

const CLAUDE_ID = '5b1f0c1e-7d7c-4c0e-9a55-0f1f2e3d4c5b'
const CODEX_ID = '01a0a697-11e7-7cc0-9e21-eb1844eb3128'

let studio: TestComputer
let laptop: TestComputer
let disposers: (() => void)[] = []
let source: ReturnType<typeof testPort>
let destination: ReturnType<typeof testPort>
let records: ReturnType<typeof memorySessionRelocationRecords>
let minted = 5_000

beforeEach(async () => {
  const a = await testComputer('Studio')
  const b = await testComputer('Laptop')
  studio = a.computer
  laptop = b.computer
  disposers = [a.dispose, b.dispose]
  source = testPort(studio)
  destination = testPort(laptop)
  records = memorySessionRelocationRecords()
})
afterEach(() => {
  for (const dispose of disposers) {
    dispose()
  }
})

function deps(overrides: Partial<SessionRelocateDeps> = {}): SessionRelocateDeps {
  let clock = 0
  return {
    source,
    destination,
    channel: SAME_DISK_RELOCATION_CHANNEL,
    records,
    relocationEnabled: () => true,
    mintOperationId: () => fixtureOperationId(minted++),
    now: () => TEST_NOW,
    step: { waitMs: 40, pollMs: 1, sleep: async () => {}, now: () => (clock += 10) },
    ...overrides
  }
}

function input(conversationId: string, extra: Record<string, unknown> = {}) {
  return {
    conversationId,
    origin: PERSON_ON_STUDIO,
    workspace: { kind: 'folder' as const, path: '/work/Laptop' },
    providerVersion: '2.1.0',
    dryRun: false,
    ...extra
  }
}

function journal(computer: TestComputer) {
  return computer.service.store.snapshot()!
}

/** What any other computer asking the source to run the conversation again would get. */
async function sourceRuns(conversationId: string, action: 'continue' | 'restart') {
  const request = {
    operationId: fixtureOperationId(minted++),
    conversationId,
    expectedOwnerEpoch: 1,
    expectedTurnRevision: 'turn:1',
    origin: PERSON_ON_STUDIO,
    action,
    payload: action === 'continue' ? { answer: { kind: 'prompt', text: 'Go on.' } } : {}
  } as SessionHostRequest
  const reply = await testPort(studio, 'paired:another-mac').execute(request)
  return reply.status === 'ok'
    ? (reply.operation.refusal?.code ?? reply.operation.state)
    : reply.refusal.code
}

describe('session relocate moves the same conversation', () => {
  it('moves a Claude conversation with its complete history and resumes the identical id once', async () => {
    const conversation = await studio.conversation('claude', CLAUDE_ID, 40)
    const result = await relocateConversation(deps(), input(conversation.conversationId))

    expect(result.outcome).toBe('relocated')
    expect(result.ownerEpoch).toBe(2)
    expect(result.steps.map((step) => [step.step, step.state])).toEqual([
      ['prepare-destination', 'completed'],
      ['reserve-source', 'admitted'],
      ['freeze-source', 'completed'],
      ['export', 'completed'],
      ['copy', 'done'],
      ['stage', 'completed'],
      ['relinquish', 'completed'],
      ['resume', 'completed']
    ])
    const moved = join(
      laptop.providerRoot('claude'),
      'projects',
      encodeClaudeProjectPath('/work/Laptop'),
      `${CLAUDE_ID}.jsonl`
    )
    expect(laptop.launched).toEqual([{ sessionId: CLAUDE_ID, transcriptPath: moved }])
    expect(readFileSync(moved, 'utf8')).toBe(
      readFileSync(studio.transcriptOf({ agent: 'claude', sessionId: CLAUDE_ID })!, 'utf8')
    )
    expect(readFileSync(moved, 'utf8').trim().split('\n')).toHaveLength(40)
    // Credentials stay with their own computer.
    expect(existsSync(join(laptop.providerRoot('claude'), '.credentials.json'))).toBe(false)

    const there = journal(laptop).conversations[conversation.conversationId]!
    expect(there).toMatchObject({
      owned: true,
      adopted: true,
      ownerEpoch: 2,
      provider: { agent: 'claude', sessionId: CLAUDE_ID }
    })
    expect(there.binding?.paneKey).toBe('tab-1:leaf-1')
    const here = journal(studio).conversations[conversation.conversationId]!
    expect(here).toMatchObject({ owned: false, relinquishment: { relinquishedEpoch: 1 } })
    expect(studio.retired).toEqual([conversation.conversationId])
    expect(await sourceRuns(conversation.conversationId, 'continue')).toBe('not-owner')
    expect(await sourceRuns(conversation.conversationId, 'restart')).toBe('not-owner')
  })

  it('moves a Codex conversation and resumes it under the destination home only', async () => {
    const conversation = await studio.conversation('codex', CODEX_ID, 30)
    const result = await relocateConversation(deps(), input(conversation.conversationId))
    expect(result.outcome).toBe('relocated')
    expect(laptop.launched).toHaveLength(1)
    const [launch] = laptop.launched
    expect(launch!.sessionId).toBe(CODEX_ID)
    expect(launch!.transcriptPath.startsWith(join(laptop.providerRoot('codex'), 'sessions'))).toBe(
      true
    )
    expect(readFileSync(launch!.transcriptPath, 'utf8')).toBe(
      readFileSync(studio.transcriptOf({ agent: 'codex', sessionId: CODEX_ID })!, 'utf8')
    )
    expect(existsSync(join(laptop.providerRoot('codex'), 'auth.json'))).toBe(false)
  })

  it('only proposes it for an unattended caller, and touches neither computer', async () => {
    const conversation = await studio.conversation('claude', CLAUDE_ID)
    const result = await relocateConversation(
      deps(),
      input(conversation.conversationId, { origin: STEWARD_ON_STUDIO })
    )
    expect(result.outcome).toBe('proposed')
    expect(result.summary).toMatch(/needs a person to ask for it/)
    expect(Object.keys(journal(studio).operations)).toEqual([])
    expect(Object.keys(journal(laptop).operations)).toEqual([])
    expect(records.records.size).toBe(0)
  })

  it('is refused by either switch before the source is touched', async () => {
    const conversation = await studio.conversation('claude', CLAUDE_ID)
    const off = await relocateConversation(
      deps({ relocationEnabled: () => false }),
      input(conversation.conversationId)
    )
    expect([off.outcome, off.code]).toEqual(['refused', 'relocation-disabled'])
    laptop.relocationOn = false
    const there = await relocateConversation(deps(), input(conversation.conversationId))
    expect([there.outcome, there.code]).toEqual(['refused', 'relocation-disabled'])
    expect(Object.keys(journal(studio).operations)).toEqual([])
    expect(laptop.launched).toEqual([])
  })

  it('gives the conversation back untouched when the source cannot prove it stopped', async () => {
    const conversation = await studio.conversation('claude', CLAUDE_ID)
    studio.stops = false
    const result = await relocateConversation(deps(), input(conversation.conversationId))
    expect(result.outcome).toBe('abandoned')
    expect(result.steps.at(-1)).toMatchObject({ step: 'release-source', state: 'completed' })
    const observed = await source.observe({ conversationIds: [conversation.conversationId] })
    expect(observed.status === 'ok' && observed.sessions[0]).toMatchObject({
      admission: 'open',
      ownerEpoch: 1
    })
    expect(observed.status === 'ok' && observed.sessions[0]?.reservation).toBeUndefined()
    expect(journal(laptop).conversations[conversation.conversationId]).toBeUndefined()
    const again = await relocateConversation(
      deps(),
      input(conversation.conversationId, { relocation: result.relocation })
    )
    expect(again.outcome).toBe('abandoned')
  })
})

describe('a move that loses contact never creates two executors', () => {
  it('blocks after relinquishment while the destination is dark, then resumes once', async () => {
    const conversation = await studio.conversation('claude', CLAUDE_ID)
    const beforeResume = destination.execute
    destination.execute = async (request) => {
      if (request.action === 'relocate.resume') {
        destination.faults.down = true
      }
      return await beforeResume(request)
    }
    const blocked = await relocateConversation(deps(), input(conversation.conversationId))
    expect([blocked.outcome, blocked.code]).toEqual(['blocked', 'host-unreachable'])
    expect(blocked.summary).toMatch(/never restarts it/)
    // Nobody runs it: the source relinquished, the destination has not taken it.
    expect(journal(studio).conversations[conversation.conversationId]!.owned).toBe(false)
    expect(journal(laptop).conversations[conversation.conversationId]).toBeUndefined()
    expect(laptop.launched).toEqual([])
    expect(await sourceRuns(conversation.conversationId, 'restart')).toBe('not-owner')
    const retry = await relocateConversation(deps(), input(conversation.conversationId))
    expect(retry.outcome).toBe('refused')

    destination.execute = beforeResume
    destination.faults.down = false
    const resumed = await relocateConversation(
      deps(),
      input(conversation.conversationId, { relocation: blocked.relocation })
    )
    expect(resumed.outcome).toBe('relocated')
    const finished = await relocateConversation(
      deps(),
      input(conversation.conversationId, { relocation: blocked.relocation })
    )
    expect(finished.outcome).toBe('relocated')
    expect(laptop.launched).toHaveLength(1)
    expect(Object.keys(journal(laptop).grants)).toHaveLength(1)
  })

  it('never restarts or releases the source when the relinquish acknowledgment is lost', async () => {
    const conversation = await studio.conversation('claude', CLAUDE_ID)
    source.faults.downAfter.add('relocate.relinquish')
    const blocked = await relocateConversation(deps(), input(conversation.conversationId))
    expect(blocked.outcome).toBe('blocked')
    expect(blocked.summary).toMatch(/did not answer whether it handed the conversation over/)
    const operations = Object.values(journal(studio).operations)
    expect(operations.some((operation) => operation.kind === 'release')).toBe(false)
    expect(operations.find((operation) => operation.action === 'relocate.relinquish')?.state).toBe(
      'completed'
    )
    expect(await sourceRuns(conversation.conversationId, 'restart')).toBe('not-owner')
    expect(laptop.launched).toEqual([])

    source.faults.down = false
    const resumed = await relocateConversation(
      deps(),
      input(conversation.conversationId, { relocation: blocked.relocation })
    )
    expect(resumed.outcome).toBe('relocated')
    expect(laptop.launched).toHaveLength(1)
  })

  it('records nothing it could not build from a fresh reading, and carries on when the source is back', async () => {
    const conversation = await studio.conversation('claude', CLAUDE_ID)
    destination.faults.downAfter.clear()
    const prepare = destination.execute
    destination.execute = async (request) => {
      const reply = await prepare(request)
      if (request.action === 'relocate.prepare-destination') {
        source.faults.down = true
      }
      return reply
    }
    const blocked = await relocateConversation(deps(), input(conversation.conversationId))
    expect([blocked.outcome, blocked.code]).toEqual(['blocked', 'host-unreachable'])
    expect(records.records.get(blocked.relocation!)!.requests['reserve-source']).toBeUndefined()
    expect(Object.keys(journal(studio).operations)).toEqual([])
    destination.execute = prepare
    source.faults.down = false
    const moved = await relocateConversation(
      deps(),
      input(conversation.conversationId, { relocation: blocked.relocation })
    )
    expect(moved.outcome).toBe('relocated')
  })

  it('finds out from the destination when its resume acknowledgment is lost', async () => {
    const conversation = await studio.conversation('codex', CODEX_ID)
    destination.faults.downAfter.add('relocate.resume')
    const blocked = await relocateConversation(deps(), input(conversation.conversationId))
    expect(blocked.outcome).toBe('blocked')
    expect(laptop.launched).toHaveLength(1)
    destination.faults.down = false
    const answered = await relocateConversation(
      deps(),
      input(conversation.conversationId, { relocation: blocked.relocation })
    )
    expect(answered.outcome).toBe('relocated')
    expect(laptop.launched).toHaveLength(1)
  })

  it('accepts no work on the destination when its provider reports another conversation', async () => {
    const conversation = await studio.conversation('claude', CLAUDE_ID)
    laptop.reports = () => 'a-fresh-session'
    const result = await relocateConversation(deps(), input(conversation.conversationId))
    expect(result.outcome).toBe('owned-unconfirmed')
    expect(result.summary).toMatch(/a-fresh-session/)
    const there = journal(laptop).conversations[conversation.conversationId]!
    expect([there.owned, there.ownerEpoch, there.binding]).toEqual([true, 2, null])
    const reply = await destination.execute({
      operationId: fixtureOperationId(minted++),
      conversationId: conversation.conversationId,
      expectedOwnerEpoch: 2,
      expectedTurnRevision: 'turn:1',
      origin: PERSON_ON_STUDIO,
      action: 'continue',
      payload: { answer: { kind: 'prompt', text: 'Go on.' } }
    })
    expect(reply.status === 'ok' && reply.operation.refusal?.code).toBe('turn-unknown')
    expect(laptop.delivered).toEqual([])
  })
})
