import type { AgentJournalCursor } from '../../shared/agent-session-journal-types'
import { nativeJournalPublicationCallbacks } from '../backoffice/native-task-publication-runtime'
import {
  captureConsoleWorkflowPerson,
  currentConsolePublicationScope,
  sanitizeConsoleWorkflowText
} from '../backoffice/console-workflow-person'
import type { NativeJournalObservation } from '../native-chat/agent-session-wire/structured-agent-session-host-types'
vi.mock('../backoffice/console-workflow-person', () => ({
  captureConsoleWorkflowPerson: vi.fn(),
  currentConsolePublicationScope: vi.fn(),
  sanitizeConsoleWorkflowText: vi.fn()
}))
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionJournal } from '../native-chat/agent-session-journal/journal-store'
import { openAgentSessionJournal } from '../native-chat/agent-session-journal/journal-store-factory'
import { createDeferredStructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'
import type { CodexStructuredSessionEvent } from './codex-structured-session-adapter'
let root: string
let journal: AgentSessionJournal
const checkpoint = vi.fn<(cursor: AgentJournalCursor) => void | Promise<void>>()
const errors = vi.fn()
beforeEach(async () => {
  vi.resetAllMocks()
  root = await mkdtemp(join(tmpdir(), 'omni-codex-checkpoint-'))
  journal = await openAgentSessionJournal({
    identity: {
      sessionId: 'session-codex',
      workspaceId: 'workspace',
      hostId: 'local',
      agent: 'codex',
      providerHandle: { kind: 'codex', threadId: 'thread' }
    },
    journalDir: root
  })
})
afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})
function fixture() {
  const deferred = createDeferredStructuredAgentSessionEventSink({ onError: errors })
  deferred.bind({ journal, fence: 1, publish: () => {}, checkpointWritten: checkpoint })
  const translator = createCodexJournalTranslator({
    sink: deferred.sink,
    primaryThreadId: () => 'thread'
  })
  const notify = (method: string) =>
    translator.handle({
      type: 'notification',
      sessionId: 'session-codex',
      threadId: 'thread',
      method,
      params: { turn: { id: 'turn' } }
    })
  return { deferred, translator, notify }
}
describe('real Codex lifecycle to durable checkpoint', () => {
  it.each(['turn/completed', 'ended'])(
    'checkpoints %s only after its tombstone is durable',
    async (end) => {
      const { deferred, translator, notify } = fixture()
      notify('turn/started')
      await deferred.drained()
      expect(checkpoint).not.toHaveBeenCalled()
      const entered = Promise.withResolvers<void>()
      const saved = Promise.withResolvers<void>()
      checkpoint.mockImplementationOnce(async () => {
        entered.resolve()
        await saved.promise
      })
      if (end === 'ended') {
        translator.handle({
          type: 'ended',
          sessionId: 'session-codex',
          reason: 'connection lost'
        } as CodexStructuredSessionEvent)
      } else {
        notify(end)
      }
      let finished = false
      const drain = deferred.drained().then(() => {
        finished = true
      })
      await entered.promise
      expect(finished).toBe(false)
      saved.resolve()
      await drain
      expect(checkpoint).toHaveBeenCalledOnce()
      expect(checkpoint).toHaveBeenCalledWith(journal.cursor())
      // Upstream #17720 discloses an unexpected provider exit as a status row. The running
      // row is still tombstoned; what remains is the settled outcome, which is how a later
      // reader knows the turn finished rather than merely stopped being observed.
      expect(journal.snapshot().items.map((item) => item.body)).toEqual(
        end === 'ended'
          ? [
              { kind: 'status', text: 'Provider exited: connection lost' },
              {
                kind: 'status',
                text: '',
                turnLifecycle: { turnId: 'turn', state: 'completed', outcome: 'unknown' }
              }
            ]
          : [
              {
                kind: 'status',
                text: '',
                turnLifecycle: { turnId: 'turn', state: 'completed', outcome: 'completed' }
              }
            ]
      )
      expect(errors).not.toHaveBeenCalled()
      translator.dispose()
      deferred.close()
    }
  )
  it('does not report a saved checkpoint when the lifecycle tombstone cannot persist', async () => {
    const { deferred, translator, notify } = fixture()
    notify('turn/started')
    await deferred.drained()
    // Upstream #17720 settles a completed turn through one lifecycle batch rather
    // than a bare tombstone; the durable write under test is that batch.
    vi.spyOn(journal, 'appendLifecycleBatch').mockRejectedValueOnce(new Error('disk full'))
    notify('turn/completed')
    await deferred.drained()
    expect(checkpoint).not.toHaveBeenCalled()
    expect(errors).toHaveBeenCalledOnce()
    translator.dispose()
    deferred.close()
  })
})

it('carries a real Codex boundary through local retention, HTTP delivery and durable acknowledgement', async () => {
  vi.stubEnv('OMNI_NATIVE_TASK_SAVE_DELIVERY', '1')
  const scope = {
    principal: 'a'.repeat(64),
    profileKey: 'b'.repeat(64),
    baseUrl: 'https://console.example.com'
  }
  vi.mocked(currentConsolePublicationScope).mockReturnValue(scope)
  vi.mocked(captureConsoleWorkflowPerson).mockResolvedValue({
    ok: true,
    data: {
      ...scope,
      bearer: 'fixture-only-token',
      isCurrent: () => true
    }
  })
  vi.mocked(sanitizeConsoleWorkflowText).mockImplementation((value) => value)
  const statuses: string[] = []
  const reopen = () =>
    openAgentSessionJournal({
      identity: {
        sessionId: 'session-codex',
        workspaceId: 'workspace',
        hostId: 'local',
        agent: 'codex',
        providerHandle: { kind: 'codex', threadId: 'thread' }
      },
      journalDir: root
    })
  const network = vi.fn(async (_url: unknown, init: RequestInit) => {
    const restored = await reopen()
    const pending = restored.taskPublications()
    expect(pending).toHaveLength(1)
    expect(pending[0].request).toBe(init.body)
    expect(pending[0].noteId).toBeNull()
    const body = JSON.parse(String(init.body))
    return Response.json({ ...body, id: 'tve_flow', task_id: 'btk_1234', note_replay_version: 1 })
  })
  vi.stubGlobal('fetch', network)
  checkpoint.mockImplementation((cursor) =>
    nativeJournalPublicationCallbacks.onCheckpoint({
      record: {
        sessionId: 'session-codex',
        hubTaskId: 'btk_1234',
        lease: { runtimeFence: 1 }
      } as NativeJournalObservation['record'],
      journal,
      cursor,
      isCurrent: () => true,
      onTaskSave: (status) => {
        statuses.push(status.state)
      }
    })
  )
  const { deferred, translator, notify } = fixture()
  notify('turn/started')
  notify('turn/completed')
  await deferred.drained()
  await vi.waitFor(() => expect(statuses.at(-1)).toBe('shared'))
  expect(network).toHaveBeenCalledOnce()
  expect((await reopen()).taskPublications()[0].noteId).toBe('tve_flow')
  expect(statuses).toEqual(['saving', 'pending', 'shared'])
  expect(JSON.stringify((await reopen()).taskPublications())).not.toContain('fixture-only-token')
  expect(errors).not.toHaveBeenCalled()
  translator.dispose()
  deferred.close()
})
