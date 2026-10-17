import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { captureConsoleWorkflowPerson } from '../../backoffice/console-workflow-person'
import {
  recoverNativeTaskPublications,
  retainNativeTaskObservation
} from '../../backoffice/native-task-publication'
import { nativeJournalPublicationCallbacks } from '../../backoffice/native-task-publication-runtime'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import type { NativeJournalObservation } from './structured-agent-session-host-types'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION,
  hostTestAttachParams,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'

vi.mock('../../backoffice/console-workflow-person', () => ({
  captureConsoleWorkflowPerson: vi.fn(),
  sanitizeConsoleWorkflowText: (value: string) => value,
  currentConsolePublicationScope: () => scope
}))
const scope = {
  principal: 'b'.repeat(64),
  profileKey: 'd'.repeat(64),
  baseUrl: 'https://console.example.com'
}
let root = ''
const hosts: StructuredAgentSessionHost[] = []
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.flushAllStreamedEvents()))
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
})

it('keeps a lost-response note through history restoration and replays it after ownership recovery', async () => {
  root = await mkdtemp(join(tmpdir(), 'ide-publication-restore-'))
  resetHostTestOperationIds()
  vi.stubEnv('OMNI_NATIVE_TASK_SAVE_DELIVERY', '1')
  vi.mocked(captureConsoleWorkflowPerson).mockResolvedValue({
    ok: true,
    data: { ...scope, bearer: 'test-token', isCurrent: () => true }
  })
  const network = vi
    .fn()
    .mockRejectedValueOnce(new Error('lost response'))
    .mockImplementation(async (_url, init) =>
      Response.json({
        ...JSON.parse(String(init.body)),
        id: 'tve_saved',
        task_id: 'btk_1234',
        note_replay_version: 1
      })
    )
  vi.stubGlobal('fetch', network)
  const observed: NativeJournalObservation[] = []
  const makeHost = async (ready: (input: NativeJournalObservation) => void) => {
    const store = await AgentSessionRecordStore.open({
      directory: join(root, 'store'),
      hostId: 'local'
    })
    const adapter: StructuredAgentSessionAdapter = {
      supportsCreate: () => true,
      acquire: vi.fn<StructuredAgentSessionAdapter['acquire']>(async ({ fence, spawnToken }) => ({
        process: { hostId: 'local', pid: 4242, processStartTimeMs: HOST_TEST_NOW, spawnToken },
        link: {
          linkId: `link-${fence}`,
          handle: { provider: 'claude', sessionId: 'claude-session', leafUuid: null },
          origin: store.getRecord(HOST_TEST_SESSION)?.providerHandleChain.length
            ? 'resumed'
            : 'created',
          mintedAtFence: fence,
          observedAt: HOST_TEST_NOW
        }
      })),
      dispatch: async () => ({ state: 'rejected', reason: 'unused' }),
      cancelTurn: async () => ({ cancelled: false }),
      answerPrompt: async () => undefined,
      setOption: async () => undefined
    }
    const host = new StructuredAgentSessionHost({
      store,
      adapter,
      journalRoot: root,
      claimKeyId: 'key-1',
      mintSpawnToken: () => 'spawn-a',
      probeOwner: async () => ({ outcome: 'pid-absent' }),
      onJournalReady: ready,
      resolveWorkspaceHubTaskId: () => 'btk_1234',
      now: () => HOST_TEST_NOW
    })
    hosts.push(host)
    return host
  }
  const params = (fence: number | null) =>
    hostTestAttachParams(fence, {
      provider: 'claude',
      agent: 'claude',
      accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/home/dev/.claude' },
      providerHandle: { kind: 'claude', sessionId: 'claude-session', leafUuid: null }
    })
  const first = await makeHost((input) => observed.push(input))
  expect(await first.attach({ callerKey: 'first' }, params(null))).toMatchObject({ ok: true })
  const original = observed[0]
  await retainNativeTaskObservation(
    original.journal,
    {
      hubTaskId: 'btk_1234',
      runId: HOST_TEST_SESSION,
      journalCursor: 'checkpoint-before-exit',
      event: 'checkpoint_written'
    },
    scope,
    original.record.lease.runtimeFence
  )
  await recoverNativeTaskPublications(
    original.journal,
    original.record.lease.runtimeFence,
    original.isCurrent
  )
  expect(network).toHaveBeenCalledOnce()
  const pending = original.journal.taskPublications()[0]
  expect(pending.noteId).toBeNull()

  const restored: NativeJournalObservation[] = []
  const restarted = await makeHost((input) => {
    restored.push(input)
    nativeJournalPublicationCallbacks.onReady(input)
  })
  await restarted.restoreReadableSessions()
  expect(restarted.deps.adapter.acquire).not.toHaveBeenCalled()
  expect(network).toHaveBeenCalledOnce()
  expect(restored[0].readOnly).toBe(true)
  expect(restored[0].journal.taskPublications()).toEqual([pending])

  const fence = restarted.deps.store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence
  // Opening the visible chat takes a surface hold; employees do not call attach themselves.
  await restarted.hold(HOST_TEST_SESSION, 'desktop-chat:restored')
  expect(restarted.deps.adapter.acquire).toHaveBeenCalledOnce()
  await vi.waitFor(() =>
    expect(restored.at(-1)!.journal.taskPublications()[0].noteId).toBe('tve_saved')
  )
  const resumed = restored.at(-1)!
  await recoverNativeTaskPublications(
    resumed.journal,
    resumed.record.lease.runtimeFence,
    resumed.isCurrent
  )
  expect(network).toHaveBeenCalledTimes(2)
  expect(network.mock.calls[1][1].body).toBe(network.mock.calls[0][1].body)
  expect(restarted.deps.store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence).toBeGreaterThan(
    fence
  )
})
