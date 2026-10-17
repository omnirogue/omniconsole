import { existsSync, readFileSync, symlinkSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  SESSION_CONTROL_OWNER_CAPABILITY,
  SESSION_RELOCATION_CLAUDE_CAPABILITY,
  readRuntimeSessionHostAdvertisement
} from '../../shared/session-host-capabilities'
import { SESSION_HOST_UNREACHABLE, SessionHostClient } from '../../shared/session-host-client'
import { fixtureOperationId, phase4RuntimeStatus } from '../../shared/session-host-wire-fixtures'
import { TEST_NOW } from '../session-host/session-host-test-fixture'
import {
  PERSON_ON_STUDIO,
  STEWARD_ON_STUDIO,
  type TestComputer
} from './session-transfer-host-fixture'
import { testComputer, testPort } from './session-transfer-port-fixture'
import { sessionHostClientPort } from './session-transfer-host-port'
import { relocateConversation, type SessionRelocateDeps } from './session-transfer-relocate'
import { sessionHostRelocationChannel } from './session-transfer-relocate-channel'
import { memorySessionRelocationRecords } from './session-transfer-relocate-record'
import { readRelocationStaged, relocationStagingDir } from './session-transfer-relocation-records'

const CLAUDE_ID = '5b1f0c1e-7d7c-4c0e-9a55-0f1f2e3d4c5b'
const CODEX_ID = '01a0a697-11e7-7cc0-9e21-eb1844eb3128'
// Enough records that each transcript needs several 256 KiB chunks.
const LONG = 20_000

let studio: TestComputer
let laptop: TestComputer
let disposers: (() => void)[] = []
let source: ReturnType<typeof testPort>
let destination: ReturnType<typeof testPort>
let records: ReturnType<typeof memorySessionRelocationRecords>
let minted = 40_000

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

function deps(): SessionRelocateDeps {
  let clock = 0
  return {
    source,
    destination,
    channel: sessionHostRelocationChannel({ attempts: 3, sleep: async () => {} }),
    records,
    relocationEnabled: () => true,
    mintOperationId: () => fixtureOperationId(minted++),
    now: () => TEST_NOW,
    step: { waitMs: 40, pollMs: 1, sleep: async () => {}, now: () => (clock += 10) }
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

async function sourceIntact(conversationId: string, transcript: string, before: string) {
  const observed = await source.observe({ conversationIds: [conversationId] })
  const row = observed.status === 'ok' ? observed.sessions[0] : undefined
  expect(row).toMatchObject({ ownerEpoch: 1, admission: 'open' })
  expect(row?.reservation).toBeUndefined()
  expect(studio.service.store.snapshot()!.conversations[conversationId]!.owned).toBe(true)
  expect(readFileSync(transcript, 'utf8')).toBe(before)
}

describe('relocation across two computers, through each host’s own bundle calls', () => {
  it.each([
    ['claude', CLAUDE_ID],
    ['codex', CODEX_ID]
  ] as const)(
    'moves a long %s conversation chunk by chunk and resumes the identical id with its whole history',
    async (provider, sessionId) => {
      const conversation = await studio.conversation(provider, sessionId, LONG)
      const original = readFileSync(studio.transcriptOf({ agent: provider, sessionId })!, 'utf8')
      expect(original.length).toBeGreaterThan(2 * 256 * 1024)
      const result = await relocateConversation(deps(), input(conversation.conversationId))
      expect([result.outcome, result.ownerEpoch]).toEqual(['relocated', 2])
      expect(laptop.launched).toHaveLength(1)
      const [launch] = laptop.launched
      expect(launch!.sessionId).toBe(sessionId)
      expect(readFileSync(launch!.transcriptPath, 'utf8')).toBe(original)
      expect(
        existsSync(
          join(
            laptop.providerRoot(provider),
            provider === 'claude' ? '.credentials.json' : 'auth.json'
          )
        )
      ).toBe(false)
    }
  )

  it('resumes a copy whose write reply was lost instead of writing the chunk twice', async () => {
    const conversation = await studio.conversation('claude', CLAUDE_ID, LONG)
    const original = readFileSync(
      studio.transcriptOf({ agent: 'claude', sessionId: CLAUDE_ID })!,
      'utf8'
    )
    destination.faults.dropChunkWriteReply = true
    const result = await relocateConversation(deps(), input(conversation.conversationId))
    expect(result.outcome).toBe('relocated')
    expect(readFileSync(laptop.launched[0]!.transcriptPath, 'utf8')).toBe(original)
  })
})

describe('a transfer that goes wrong leaves the source intact and the destination unstaged', () => {
  it('refuses to stage bytes that do not match the manifest', async () => {
    const conversation = await studio.conversation('claude', CLAUDE_ID, LONG)
    const transcript = studio.transcriptOf({ agent: 'claude', sessionId: CLAUDE_ID })!
    const before = readFileSync(transcript, 'utf8')
    source.faults.tamperRead = (base64) => {
      const bytes = Buffer.from(base64, 'base64')
      bytes[0] = bytes[0]! ^ 0xff
      return bytes.toString('base64')
    }
    const result = await relocateConversation(deps(), input(conversation.conversationId))
    expect(result.outcome).toBe('abandoned')
    expect(result.steps.find((step) => step.step === 'stage')?.state).toBe('refused')
    expect(readRelocationStaged(laptop.service.store, result.relocation!)).toBeNull()
    expect(laptop.launched).toEqual([])
    studio.frozen.clear()
    await sourceIntact(conversation.conversationId, transcript, before)
  })

  it('stops a copy cut off mid-transfer before anything is staged or handed over', async () => {
    const conversation = await studio.conversation('codex', CODEX_ID, LONG)
    const transcript = studio.transcriptOf({ agent: 'codex', sessionId: CODEX_ID })!
    const before = readFileSync(transcript, 'utf8')
    destination.faults.downAfterWrites = 1
    const result = await relocateConversation(deps(), input(conversation.conversationId))
    expect(result.outcome).toBe('abandoned')
    expect(result.steps.find((step) => step.step === 'copy')?.state).toBe('failed')
    expect(result.steps.some((step) => step.step === 'stage' || step.step === 'relinquish')).toBe(
      false
    )
    destination.faults.down = false
    expect(readRelocationStaged(laptop.service.store, result.relocation!)).toBeNull()
    expect(
      laptop.service.store.snapshot()!.conversations[conversation.conversationId]
    ).toBeUndefined()
    studio.frozen.clear()
    await sourceIntact(conversation.conversationId, transcript, before)
  })
})

describe('only a host that speaks relocation, and only the peer that ran each step', () => {
  it('refuses cleanly, before touching either computer, when a host lacks the bundle calls', async () => {
    const conversation = await studio.conversation('claude', CLAUDE_ID)
    const older = {
      ...destination,
      relocationBundleWrite: async () => ({
        status: 'refused' as const,
        refusal: {
          code: 'unsupported-capability',
          message: 'That computer’s OmniConsole has no sessionHost.relocationBundleWrite.'
        }
      })
    }
    const result = await relocateConversation(
      { ...deps(), destination: older },
      input(conversation.conversationId)
    )
    expect([result.outcome, result.code]).toEqual(['refused', 'unsupported-capability'])
    expect(result.summary).toMatch(/Update OmniConsole there first/)
    expect(Object.keys(studio.service.store.snapshot()!.operations)).toEqual([])
    expect(Object.keys(laptop.service.store.snapshot()!.operations)).toEqual([])
  })

  it('never offers a move to a host that relocates but cannot move bundles (negotiated, not probed)', async () => {
    const conversation = await studio.conversation('claude', CLAUDE_ID)
    const called: string[] = []
    const client = new SessionHostClient({
      probe: async () =>
        readRuntimeSessionHostAdvertisement(
          phase4RuntimeStatus(
            [SESSION_CONTROL_OWNER_CAPABILITY, SESSION_RELOCATION_CLAUDE_CAPABILITY],
            { hostId: laptop.service.identity.hostId, incarnation: 'laptop-runtime' }
          )
        ),
      call: async (method) => {
        called.push(method)
        return { ok: false, error: { code: 'method_not_found' } }
      },
      connection: () => null
    })
    const older = sessionHostClientPort(client, {
      hostId: laptop.service.identity.hostId,
      label: 'Laptop'
    })
    const result = await relocateConversation(
      { ...deps(), destination: older },
      input(conversation.conversationId)
    )
    expect([result.outcome, result.code]).toEqual(['refused', 'unsupported-capability'])
    expect(result.summary).toMatch(/Update OmniConsole there first/)
    expect(called).toEqual([])
    expect(Object.keys(studio.service.store.snapshot()!.operations)).toEqual([])
  })

  it('refuses an unreachable host and an unattended caller before anything moves', async () => {
    const conversation = await studio.conversation('claude', CLAUDE_ID)
    const dark = {
      ...destination,
      relocationBundleWrite: async () => ({
        status: 'refused' as const,
        refusal: SESSION_HOST_UNREACHABLE
      })
    }
    const unreachable = await relocateConversation(
      { ...deps(), destination: dark },
      input(conversation.conversationId)
    )
    expect([unreachable.outcome, unreachable.code]).toEqual(['refused', 'host-unreachable'])
    const proposed = await relocateConversation(
      deps(),
      input(conversation.conversationId, { origin: STEWARD_ON_STUDIO })
    )
    expect(proposed.outcome).toBe('proposed')
    expect(Object.keys(studio.service.store.snapshot()!.operations)).toEqual([])
    expect(laptop.launched).toEqual([])
  })

  it('serves a bundle only to the peer that exported it, and stages only what that peer was prepared for', async () => {
    const conversation = await studio.conversation('claude', CLAUDE_ID, LONG)
    // Cut off mid-copy: the destination is prepared, holds part of the bundle, and is not staged.
    destination.faults.downAfterWrites = 1
    const stopped = await relocateConversation(deps(), input(conversation.conversationId))
    const relocation = stopped.relocation!
    const record = records.records.get(relocation)!
    const path = record.manifest!.files[0]!.path
    const bundle = {
      relocation,
      conversationId: conversation.conversationId,
      provider: 'claude' as const
    }
    const stranger = testPort(studio, 'paired:another-mac')
    const read = await stranger.relocationBundleRead({ ...bundle, path, offset: 0, length: 16 })
    expect(read.status === 'refused' && read.refusal.code).toBe('not-eligible')
    const intruder = testPort(laptop, 'paired:another-mac')
    const write = await intruder.relocationBundleWrite({
      ...bundle,
      path: 'extra.jsonl',
      offset: 0,
      size: 1,
      base64: 'eA=='
    })
    expect(write.status === 'refused' && write.refusal.code).toBe('not-eligible')
    destination.faults.down = false
    destination.faults.downAfterWrites = null
    const credential = await destination.relocationBundleWrite({
      ...bundle,
      path: `${CLAUDE_ID}/.credentials.json`,
      offset: 0,
      size: 2,
      base64: 'e30='
    })
    expect(credential.status === 'refused' && credential.refusal.code).toBe('not-eligible')
    const outside = join(laptop.root, 'outside')
    mkdirSync(outside, { recursive: true })
    symlinkSync(outside, join(relocationStagingDir(laptop.service.store, relocation), 'linked'))
    const linked = await destination.relocationBundleWrite({
      ...bundle,
      path: 'linked/x.jsonl',
      offset: 0,
      size: 1,
      base64: 'eA=='
    })
    expect(linked.status === 'refused' && linked.refusal.code).toBe('not-eligible')
    expect(existsSync(join(outside, 'x.jsonl'))).toBe(false)
  })
})
