import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LaunchLedgerRow } from '../../../shared/launch-ledger'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import { hostTestAttachParams } from './structured-agent-session-host-test-data'
import {
  flushLaunchLedger,
  setLaunchLedgerDirectory,
  _resetLaunchLedgerForTests
} from '../../launch-ledger/launch-ledger'
import * as ledger from '../../launch-ledger/launch-ledger'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'

const SESSION = 'claude_11111111_1111_4111_8111_111111111111'
const WORKSPACE = 'folder:22222222-2222-4222-8222-222222222222'
const OPERATION = `${Date.now()}-${'3'.repeat(32)}`
const DEVICE = '44444444-4444-4444-8444-444444444444'
let root: string
let host: StructuredAgentSessionHost | undefined

afterEach(async () => {
  vi.restoreAllMocks()
  await host?.close(SESSION)
  await _resetLaunchLedgerForTests()
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
})
async function fixture() {
  root = await mkdtemp(join(tmpdir(), 'structured-launch-ledger-'))
  await setLaunchLedgerDirectory(root)
  const store = await AgentSessionRecordStore.open({
    directory: join(root, 'records'),
    hostId: 'local'
  })
  const acquire = vi.fn<StructuredAgentSessionAdapter['acquire']>(
    async ({ fence, spawnToken }) => ({
      process: { hostId: 'local', pid: 4242, processStartTimeMs: 1800000000000, spawnToken },
      acquisitionGeneration: '55555555-5555-4555-8555-555555555555',
      link: {
        linkId: 'link-one',
        handle: { provider: 'claude', sessionId: SESSION, leafUuid: null },
        origin: 'created',
        mintedAtFence: fence,
        observedAt: 1800000000000
      }
    })
  )
  host = new StructuredAgentSessionHost({
    store,
    journalRoot: join(root, 'journals'),
    claimKeyId: 'key-one',
    mintSpawnToken: () => '66666666-6666-4666-8666-666666666666',
    adapter: {
      acquire,
      supportsCreate: () => true,
      dispatch: vi.fn(),
      cancelTurn: vi.fn(),
      answerPrompt: vi.fn(),
      setOption: vi.fn(),
      releaseAcquisition: vi.fn(async () => true)
    }
  })
  const params = hostTestAttachParams(null, {
    envelope: {
      sessionId: SESSION,
      clientOperationId: OPERATION,
      expectedRuntimeFence: null,
      payloadFingerprint: ''
    },
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: WORKSPACE,
      workspaceKind: 'folder'
    },
    provider: 'claude',
    agent: 'claude',
    runtimeKind: 'native',
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/private/account' },
    providerHandle: undefined
  })
  const caller = {
    callerKey: 'private-caller',
    launchCause: {
      trigger: 'agent-session-create' as const,
      actor: { kind: 'paired-device' as const, deviceId: DEVICE },
      requestId: OPERATION
    }
  }
  return { owner: host, acquire, store, params, caller }
}
async function rows(): Promise<LaunchLedgerRow[]> {
  await flushLaunchLedger()
  const text = await readFile(join(root, 'launch-ledger.ndjson'), 'utf8').catch(() => '')
  expect(text).not.toMatch(/private-caller|private\/account|journals|records|prompt|command/)
  return text.trim()
    ? text
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
    : []
}
describe('structured Claude acquisition provenance', () => {
  it('records one execution-owner receipt and does not record a replay as another start', async () => {
    const { owner, acquire, params, caller } = await fixture()
    const result = await owner.attach(caller, params)
    expect(result.ok, JSON.stringify(result)).toBe(true)
    expect(await owner.attach(caller, params)).toMatchObject({ ok: true })
    expect(acquire).toHaveBeenCalledTimes(1)
    expect(await rows()).toEqual([
      {
        v: 1,
        ts: expect.any(String),
        launchId: expect.any(String),
        clientMutationIdHash: createHash('sha256').update(OPERATION).digest('hex'),
        pipeline: 'structured-agent-session',
        ptyId: null,
        agent: 'claude',
        worktreeId: WORKSPACE,
        cause: 'agent-session-create',
        reference: { agentSessionId: SESSION },
        actor: { kind: 'paired-device', deviceId: DEVICE },
        requestId: OPERATION,
        process: 'created',
        hasStartupCommand: false,
        incarnationId: '55555555-5555-4555-8555-555555555555'
      }
    ])
  })
  it('falls back to unknown when host cause resolution throws', async () => {
    const { owner, params, caller } = await fixture()
    Object.defineProperty(caller, 'launchCause', {
      get() {
        throw new Error('private failure')
      }
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await owner.attach(caller, params)).toMatchObject({ ok: true })
    expect(await rows()).toEqual([
      expect.objectContaining({ cause: 'unknown', process: 'created' })
    ])
  })
  it('keeps successful acquisition unchanged when the ledger throws', async () => {
    const { owner, acquire, params, caller } = await fixture()
    vi.spyOn(ledger, 'recordLaunch').mockImplementation(() => {
      throw new Error('private failure')
    })
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await owner.attach(caller, params)).toMatchObject({ ok: true })
    expect(acquire).toHaveBeenCalledTimes(1)
    expect(warning).toHaveBeenCalledWith(
      '[launch-ledger] structured-agent-session: provenance unavailable'
    )
  })
})
