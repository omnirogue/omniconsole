import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { emptyLaunchManifest, launchManifestReport } from '../shared/launch-manifest'
import { RuntimeClientError } from './runtime/types'
import {
  agentLaunchRecordStore,
  appendLaunchSend,
  classifyLaunchSend,
  mintLaunchOperationId,
  pruneLaunchRecords,
  requireSendableLaunchRecord,
  settleLaunchSend,
  type AgentLaunchRecord,
  type AgentLaunchRecordStore
} from './session-launch-record'

const HOUR = 60 * 60 * 1000
const NOW = 1_759_450_000_000
let userData = ''
let store: AgentLaunchRecordStore

function launchRecordFixture(overrides: Partial<AgentLaunchRecord> = {}): AgentLaunchRecord {
  const operationId = overrides.operationId ?? mintLaunchOperationId(NOW)
  return {
    v: 1,
    operationId,
    minted: true,
    intentKey: 'intent-a',
    createdAt: NOW,
    route: { kind: 'local' },
    executingRuntimeId: '11111111-1111-4111-8111-111111111111',
    hostId: 'local',
    hostLabel: 'this computer',
    request: {
      clientOperationId: operationId,
      worktree: 'id:repo::/work/app',
      agent: 'codex',
      prompt: 'Do the work.'
    },
    post: { done: false },
    sends: [],
    outcome: 'pending',
    summary: {
      host: {
        route: 'local',
        name: 'this computer',
        hostId: 'local',
        runtimeId: '11111111-1111-4111-8111-111111111111',
        appVersion: '1.12.19',
        why: 'where the workspace lives',
        alsoReachableAs: [],
        visibleIn: "this computer's sidebar"
      },
      workspace: { selector: 'id:repo::/work/app', hostId: 'local' },
      manifest: launchManifestReport(emptyLaunchManifest('Do the work.')),
      warnings: []
    },
    ...overrides
  }
}

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'omni-launch-records-'))
  store = agentLaunchRecordStore(userData)
})

afterEach(() => {
  rmSync(userData, { recursive: true, force: true })
})

describe('agent launch records', () => {
  it('writes the record durably before the first send and appends each send before it is sent', () => {
    const record = launchRecordFixture()
    store.write(record)
    expect(store.read(record.operationId)).toEqual(record)
    if (process.platform !== 'win32') {
      // Why: the record carries the brief, so only its owner may read it.
      expect(statSync(store.dir).mode & 0o777).toBe(0o700)
      expect(statSync(store.pathOf(record.operationId)).mode & 0o777).toBe(0o600)
    }
    const first = appendLaunchSend(record, NOW + 1)
    store.write(first)
    expect(store.read(record.operationId)?.sends).toEqual([{ at: NOW + 1, outcome: null }])
    const settled = settleLaunchSend(first, NOW + 1, {
      outcome: 'not-started',
      code: 'agent_session_account_unverified'
    })
    const second = appendLaunchSend(settled, NOW + 2)
    store.write(second)
    expect(store.read(record.operationId)).toMatchObject({
      outcome: 'refused',
      sends: [
        { at: NOW + 1, outcome: 'not-started', code: 'agent_session_account_unverified' },
        { at: NOW + 2, outcome: null }
      ]
    })
  })

  it('records a created send with its terminal and account, and never downgrades it', () => {
    const sent = appendLaunchSend(launchRecordFixture(), NOW + 1)
    const created = settleLaunchSend(
      sent,
      NOW + 1,
      { outcome: 'created' },
      {
        terminal: { handle: 'term_a', worktreeId: 'w', title: null },
        disposition: 'created',
        routing: { status: 'selected', reason: 'Bounded repair', modelEvidence: 'advertised' }
      }
    )
    expect(created).toMatchObject({
      outcome: 'created',
      terminal: { handle: 'term_a' },
      routing: { status: 'selected', reason: 'Bounded repair', modelEvidence: 'advertised' }
    })
    const late = settleLaunchSend(appendLaunchSend(created, NOW + 2), NOW + 2, {
      outcome: 'unverifiable',
      code: 'runtime_timeout'
    })
    expect(late.outcome).toBe('created')
  })

  it('classifies only allowlisted codes as not-started', () => {
    for (const code of [
      'method_not_found',
      'agent_session_operation_invalid',
      'agent_session_operation_capacity',
      'agent_session_operation_expired',
      'agent_session_operation_conflict',
      'agent_session_legacy_required',
      'agent_session_runtime_changed',
      'agent_session_account_unverified',
      'agent_session_host_mismatch'
    ]) {
      expect(classifyLaunchSend(new RuntimeClientError(code, 'refused')).outcome, code).toBe(
        'not-started'
      )
    }
    for (const code of [
      'runtime_timeout',
      'runtime_unavailable',
      'invalid_argument',
      'selector_not_found',
      'runtime_error'
    ]) {
      expect(classifyLaunchSend(new RuntimeClientError(code, 'maybe')).outcome, code).toBe(
        'unverifiable'
      )
    }
    expect(classifyLaunchSend(new Error('socket hang up'))).toEqual({
      outcome: 'unverifiable',
      message: 'socket hang up'
    })
  })

  it('prunes known outcomes after 48 h and keeps unverifiable records for 30 days', () => {
    const at = (hoursAgo: number) => NOW - hoursAgo * HOUR
    const send = (outcome: 'not-started' | 'unverifiable', hoursAgo: number) => ({
      at: at(hoursAgo),
      outcome
    })
    const records = {
      createdOld: launchRecordFixture({
        operationId: mintLaunchOperationId(at(49)),
        createdAt: at(49),
        outcome: 'created'
      }),
      createdRecent: launchRecordFixture({
        operationId: mintLaunchOperationId(at(47)),
        createdAt: at(47),
        outcome: 'created'
      }),
      refusedOld: launchRecordFixture({
        operationId: mintLaunchOperationId(at(50)),
        createdAt: at(50),
        outcome: 'refused',
        sends: [send('not-started', 49)]
      }),
      refusedAfterMaybe: launchRecordFixture({
        operationId: mintLaunchOperationId(at(51)),
        createdAt: at(51),
        outcome: 'refused',
        sends: [send('unverifiable', 51), send('not-started', 49)]
      }),
      unverifiableMonth: launchRecordFixture({
        operationId: mintLaunchOperationId(at(29 * 24)),
        createdAt: at(29 * 24),
        outcome: 'unverifiable',
        sends: [send('unverifiable', 29 * 24)]
      }),
      pendingStale: launchRecordFixture({
        operationId: mintLaunchOperationId(at(31 * 24)),
        createdAt: at(31 * 24)
      })
    }
    for (const record of Object.values(records)) {
      store.write(record)
    }
    const intents = join(store.dir, 'intents')
    mkdirSync(intents, { recursive: true })
    writeFileSync(
      join(intents, 'gone.json'),
      JSON.stringify({ operationId: records.createdOld.operationId })
    )
    writeFileSync(
      join(intents, 'kept.json'),
      JSON.stringify({ operationId: records.unverifiableMonth.operationId })
    )

    pruneLaunchRecords(store, NOW)

    const kept = (record: AgentLaunchRecord) => existsSync(store.pathOf(record.operationId))
    expect(kept(records.createdOld)).toBe(false)
    expect(kept(records.createdRecent)).toBe(true)
    expect(kept(records.refusedOld)).toBe(false)
    expect(kept(records.refusedAfterMaybe)).toBe(true)
    expect(kept(records.unverifiableMonth)).toBe(true)
    expect(kept(records.pendingStale)).toBe(false)
    expect(existsSync(join(intents, 'gone.json'))).toBe(false)
    expect(existsSync(join(intents, 'kept.json'))).toBe(true)
  })

  it('ignores corrupt records', () => {
    const corrupt = mintLaunchOperationId(NOW - 400 * HOUR)
    mkdirSync(store.dir, { recursive: true })
    writeFileSync(store.pathOf(corrupt), '{ not json')
    const misnamed = mintLaunchOperationId(NOW + 5)
    writeFileSync(
      store.pathOf(misnamed),
      JSON.stringify({ ...launchRecordFixture(), operationId: mintLaunchOperationId(NOW + 6) })
    )
    expect(store.read(corrupt)).toBeNull()
    expect(store.read(misnamed)).toBeNull()
    expect(() => pruneLaunchRecords(store, NOW)).not.toThrow()
    expect(readFileSync(store.pathOf(corrupt), 'utf8')).toBe('{ not json')
    expect(() => store.read('not-an-operation-id')).toThrow('named by its operation id')
  })

  it('never sends a record whose request a --project placement has not built yet', () => {
    const placing = { ...launchRecordFixture(), request: null }
    store.write(placing)
    expect(store.read(placing.operationId)?.request).toBeNull()
    let thrown: unknown
    try {
      requireSendableLaunchRecord(placing)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toMatchObject({
      code: 'launch_record_incomplete',
      data: { outcome: 'not-sent' }
    })
    const ready = launchRecordFixture()
    expect(requireSendableLaunchRecord(ready)).toBe(ready)
  })
})
