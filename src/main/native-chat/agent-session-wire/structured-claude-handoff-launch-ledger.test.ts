import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { LaunchLedgerRow } from '../../../shared/launch-ledger'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import {
  adapterFor,
  fakeClaude,
  identityFor,
  PROVIDER_SESSION_ID
} from '../../claude/claude-structured-session-test-support'
import { acquireNativeHandoffOwner } from './structured-agent-session-host-handoff'
import { hostTestAttachParams } from './structured-agent-session-host-test-data'
import { createDeferredStructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-store-test-open'
import {
  flushLaunchLedger,
  setLaunchLedgerDirectory,
  _resetLaunchLedgerForTests
} from '../../launch-ledger/launch-ledger'

const SESSION = 'claude_11111111_1111_4111_8111_111111111111'
const OPERATION = `${Date.now()}-${'7'.repeat(32)}`
const journals = createTrackedJournalOpener()
let root: string
let adapter: ReturnType<typeof adapterFor> | undefined
afterEach(async () => {
  await adapter?.closeSession(SESSION)
  await journals.closeAll()
  await _resetLaunchLedgerForTests()
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
})
it('records one native handoff-recovered Claude child with host handoff ownership', async () => {
  root = await mkdtemp(join(tmpdir(), 'handoff-claude-receipt-'))
  await setLaunchLedgerDirectory(root)
  const store = await AgentSessionRecordStore.open({
    directory: join(root, 'store'),
    hostId: 'local'
  })
  const params = hostTestAttachParams(null, {
    provider: 'claude',
    agent: 'claude',
    runtimeKind: 'native',
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'folder:22222222-2222-4222-8222-222222222222',
      workspaceKind: 'folder'
    },
    providerHandle: { kind: 'claude', sessionId: PROVIDER_SESSION_ID, leafUuid: null },
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/private/account' }
  })
  const reserved = await store.reserveOwner({
    sessionId: SESSION,
    location: params.location,
    provider: 'claude',
    accountHome: params.accountHome,
    runtimeKind: 'native',
    expectedFence: null,
    spawnToken: 'native-handoff',
    claimKeyId: 'key-one',
    adoptedHandleLink: {
      linkId: 'adopted-link',
      handle: { provider: 'claude', sessionId: PROVIDER_SESSION_ID, leafUuid: null },
      origin: 'adopted',
      mintedAtFence: 1,
      observedAt: Date.now()
    },
    handoffOperationId: OPERATION,
    probe: { outcome: 'reservation-unused' },
    operation: { callerKey: 'host', operationId: OPERATION, fingerprint: 'handoff' },
    now: Date.now()
  })
  const journal = await journals.open({
    identity: {
      ...identityFor(SESSION),
      workspaceId: params.location.workspaceId,
      hostId: 'local'
    },
    journalDir: join(root, 'journal')
  })
  const session = {
    journal,
    params,
    fence: reserved.record.lease.runtimeFence,
    hasProviderChild: false,
    acquisitionGeneration: null as string | null
  }
  const claude = fakeClaude()
  adapter = adapterFor(claude, { resumed: true })
  const sink = createDeferredStructuredAgentSessionEventSink()
  const result = await acquireNativeHandoffOwner(
    { store, adapter, journalRoot: root, claimKeyId: 'key-one' },
    {
      session: () => session,
      findSession: () => session,
      eventSink: () => sink,
      flush: async () => {},
      serialize: async (_id, task) => task(),
      now: () => Date.now(),
      subscribers: { statusChanged: vi.fn(), publish: vi.fn(), snapshot: vi.fn() } as never
    },
    { sessionId: SESSION, fence: session.fence, spawnToken: 'native-handoff' }
  )
  expect(result.lease.claimStatus).toBe('live')
  expect(claude.connections).toHaveLength(1)
  await flushLaunchLedger()
  const text = await readFile(join(root, 'launch-ledger.ndjson'), 'utf8').catch(() => '')
  expect(text).not.toMatch(/native-handoff|\/private|\/accounts|\/work/)
  const events: LaunchLedgerRow[] = text.trim()
    ? text
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
    : []
  const rows = [...new Map(events.map((row) => [row.launchId, row])).values()]
  expect(rows).toEqual([
    {
      v: 1,
      ts: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
      launchId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      incarnationId: session.acquisitionGeneration,
      pipeline: 'structured-agent-session',
      ptyId: null,
      worktreeId: params.location.workspaceId,
      agent: 'claude',
      cause: 'session-handoff',
      actor: { kind: 'app' },
      reference: { agentSessionId: SESSION },
      requestId: OPERATION,
      clientMutationIdHash: createHash('sha256').update(OPERATION).digest('hex'),
      process: 'created',
      hasStartupCommand: false
    }
  ])
  expect(events.filter((row) => !row.incarnationId)).toHaveLength(1)
})
