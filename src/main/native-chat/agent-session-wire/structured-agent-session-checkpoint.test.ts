import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session-wire'
import type { NativeJournalObservation } from './structured-agent-session-host-types'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openJournalDatabase } from '../agent-session-journal/journal-database'
import { journalDatabaseFile, journalDirectoryFor } from '../agent-session-journal/journal-paths'
import { parseJournalRow, type JournalRow } from '../agent-session-journal/journal-row-schema'
import * as rowTable from '../agent-session-journal/journal-row-table'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { StructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION,
  HOST_TEST_THREAD,
  hostTestAttachParams,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'

let directory: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let sink: StructuredAgentSessionEventSink
/** Set by the one test that deliberately breaks the journal: upstream #17720
 *  latches that failure on the sink, so the shared teardown drain would rethrow it. */
let sinkFailureExpected = false
const checkpoint = vi.fn<(input: NativeJournalObservation) => void | Promise<void>>()
const started = vi.fn<(input: NativeJournalObservation) => void | Promise<void>>()

function createHost(): StructuredAgentSessionHost {
  const adapter: StructuredAgentSessionAdapter = {
    acquire: async ({ fence, spawnToken, events }) => {
      sink = events!
      return {
        process: {
          hostId: 'local',
          pid: 4242 + fence,
          processStartTimeMs: HOST_TEST_NOW,
          spawnToken
        },
        link: {
          linkId: `link-${fence}`,
          handle: { provider: 'codex', threadId: HOST_TEST_THREAD },
          origin: fence === 1 ? 'created' : 'resumed',
          mintedAtFence: fence,
          observedAt: HOST_TEST_NOW
        }
      }
    },
    dispatch: async () => ({ state: 'unknown', reason: 'fixture' }),
    cancelTurn: async () => ({ cancelled: true }),
    answerPrompt: async () => undefined,
    setOption: async () => undefined
  }
  return new StructuredAgentSessionHost({
    store,
    adapter,
    journalRoot: directory,
    claimKeyId: 'key-1',
    probeOwner: async () => ({ outcome: 'pid-absent' }),
    resolveWorkspaceHubTaskId: () => 'btk_1234',
    onJournalCheckpoint: checkpoint,
    onSessionStarted: started,
    now: () => HOST_TEST_NOW
  })
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'omni-session-checkpoint-'))
  resetHostTestOperationIds()
  checkpoint.mockReset()
  started.mockReset()
  store = await AgentSessionRecordStore.open({
    directory: join(directory, 'store'),
    hostId: 'local'
  })
  host = createHost()
})

afterEach(async () => {
  if (sinkFailureExpected) {
    sinkFailureExpected = false
    await host.flushAllStreamedEvents().catch(() => undefined)
  } else {
    await host.flushAllStreamedEvents()
  }
  vi.restoreAllMocks()
  await rm(directory, { recursive: true, force: true })
})

/** The rows this session has on disk. Upstream #18652 replaced the JSONL log
 *  with SQLite, so the durable read is a query against `journal_rows` on its own
 *  connection — the assertion is still "what the host reported is what landed". */
function journalRows(): JournalRow[] {
  const opened = openJournalDatabase(
    journalDatabaseFile(
      journalDirectoryFor(directory, { workspaceId: 'workspace-1', sessionId: HOST_TEST_SESSION })
    )
  )
  try {
    return (
      opened.db.prepare('SELECT row_json FROM journal_rows ORDER BY seq').all() as {
        row_json: string
      }[]
    ).flatMap((stored) => {
      const parsed = parseJournalRow(stored.row_json)
      return parsed.ok ? [parsed.row] : []
    })
  } finally {
    opened.db.close()
  }
}

function append(ordinal: number): void {
  sink.appendItem(
    { provider: 'codex', threadId: HOST_TEST_THREAD, turnId: 'turn-1', ordinal },
    {
      kind: 'status',
      text: 'Turn completed',
      turnLifecycle: { turnId: `turn-${ordinal}`, state: 'completed' }
    }
  )
}

describe('structured session durable checkpoint observations', () => {
  it('reports session creation once and does not repeat it across attach or host restart', async () => {
    const caller = { callerKey: 'client-1' }
    const params = hostTestAttachParams(null)
    expect(await host.attach(caller, params)).toMatchObject({ ok: true })
    expect(started).toHaveBeenCalledOnce()
    const observation = started.mock.calls[0]![0]
    expect(observation.record.hubTaskId).toBe('btk_1234')
    expect(journalRows()[0]).toMatchObject({
      kind: 'epoch',
      reason: 'session_created',
      epoch: observation.cursor.epoch,
      seq: observation.cursor.sequence
    })
    expect(await host.attach(caller, params)).toMatchObject({ ok: true, replayed: true })
    expect(started).toHaveBeenCalledOnce()
    const fence = store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence
    await host.flushAllStreamedEvents()
    store = await AgentSessionRecordStore.open({
      directory: join(directory, 'store'),
      hostId: 'local'
    })
    host = createHost()
    const stale = await host.attach(caller, hostTestAttachParams(fence))
    expect(stale).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_checkpoint_stale' }
    })
    if (stale.ok || stale.refusal.currentFence === undefined) {
      throw new Error('Restart must return a replacement fence.')
    }
    expect(
      await host.attach(caller, hostTestAttachParams(stale.refusal.currentFence))
    ).toMatchObject({ ok: true })
    expect(started).toHaveBeenCalledOnce()
  })

  it('reports the persisted session binding and actual journal row after append finishes', async () => {
    expect(await host.attach({ callerKey: 'client-1' }, hostTestAttachParams(null))).toMatchObject({
      ok: true
    })
    expect(checkpoint).not.toHaveBeenCalled()
    append(1)
    expect(checkpoint).not.toHaveBeenCalled()
    await host.flushStreamedEvents(HOST_TEST_SESSION)
    expect(checkpoint).toHaveBeenCalledOnce()
    const observation = checkpoint.mock.calls[0]![0]
    expect(observation.record.sessionId).toBe(HOST_TEST_SESSION)
    expect(observation.record.hubTaskId).toBe('btk_1234')
    expect(journalRows().at(-1)).toMatchObject({
      epoch: observation.cursor.epoch,
      seq: observation.cursor.sequence,
      kind: 'item'
    })
    sink.publish()
    await host.flushStreamedEvents(HOST_TEST_SESSION)
    expect(checkpoint).toHaveBeenCalledOnce()
  })

  it('carries checkpoint-note status through the real host subscription', async () => {
    await host.attach({ callerKey: 'client-1' }, hostTestAttachParams(null))
    const events: AgentSessionSubscribeEvent[] = []
    const close = host.subscribe({
      id: 'save-reader',
      sessionId: HOST_TEST_SESSION,
      emit: (event) => events.push(event)
    })
    checkpoint.mockImplementationOnce((input) => {
      input.onTaskSave?.({ taskId: input.record.hubTaskId!, state: 'pending' })
    })
    append(1)
    await host.flushStreamedEvents(HOST_TEST_SESSION)
    expect(events.at(-1)).toMatchObject({
      type: 'batch',
      taskSave: { taskId: 'btk_1234', state: 'pending' }
    })
    close()
  })

  it('does not report a checkpoint when the durable append fails', async () => {
    expect(await host.attach({ callerKey: 'client-1' }, hostTestAttachParams(null))).toMatchObject({
      ok: true
    })
    // Removing the journal directory no longer fails an append: upstream #18652
    // moved the journal onto SQLite, and an open connection keeps writing into
    // the unlinked inode. The durable write itself is what has to fail.
    vi.spyOn(rowTable, 'insertJournalRow').mockImplementationOnce(() => {
      throw new Error('durable append failed')
    })
    sinkFailureExpected = true
    append(1)
    // Upstream #17720 latches a failed durable append on the sink and surfaces it
    // at the barrier instead of dropping it; the checkpoint must still not fire.
    await expect(host.flushStreamedEvents(HOST_TEST_SESSION)).rejects.toThrow()
    expect(checkpoint).not.toHaveBeenCalled()
  })

  it('keeps token updates, active turns, and tombstones out of checkpoint notes', async () => {
    expect(await host.attach({ callerKey: 'client-1' }, hostTestAttachParams(null))).toMatchObject({
      ok: true
    })
    const identity = {
      provider: 'codex' as const,
      threadId: HOST_TEST_THREAD,
      turnId: 'turn-1',
      ordinal: 1
    }
    for (let token = 1; token <= 10; token += 1) {
      sink.appendItem(identity, {
        kind: 'message',
        role: 'assistant',
        blocks: [{ type: 'text', text: `Draft token ${token}` }]
      })
    }
    sink.appendItem(identity, {
      kind: 'status',
      text: 'Running',
      turnLifecycle: { turnId: 'turn-1', state: 'running' }
    })
    sink.appendTombstone(identity)
    await host.flushStreamedEvents(HOST_TEST_SESSION)
    expect(checkpoint).not.toHaveBeenCalled()
    append(2)
    await host.flushStreamedEvents(HOST_TEST_SESSION)
    expect(checkpoint).toHaveBeenCalledOnce()
  })

  it('waits for asynchronous local checkpoint persistence before draining', async () => {
    expect(await host.attach({ callerKey: 'client-1' }, hostTestAttachParams(null))).toMatchObject({
      ok: true
    })
    let entered!: () => void
    let saved!: () => void
    const saving = new Promise<void>((resolve) => {
      entered = resolve
    })
    const persisted = new Promise<void>((resolve) => {
      saved = resolve
    })
    checkpoint.mockImplementationOnce(() => {
      entered()
      return persisted
    })
    append(1)
    let drained = false
    const drain = host.flushStreamedEvents(HOST_TEST_SESSION).then(() => {
      drained = true
    })
    await saving
    expect(drained).toBe(false)
    saved()
    await drain
    expect(drained).toBe(true)
  })

  it('waits for local start-note persistence before completing attach', async () => {
    let entered!: () => void
    let saved!: () => void
    const saving = new Promise<void>((resolve) => {
      entered = resolve
    })
    const persisted = new Promise<void>((resolve) => {
      saved = resolve
    })
    started.mockImplementationOnce(() => {
      entered()
      return persisted
    })
    let returned = false
    const attach = host
      .attach({ callerKey: 'client-1' }, hostTestAttachParams(null))
      .then((result) => {
        returned = true
        return result
      })
    await saving
    expect(returned).toBe(false)
    saved()
    expect(await attach).toMatchObject({ ok: true })
  })

  it('keeps the journal writable when best-effort checkpoint reporting throws', async () => {
    expect(await host.attach({ callerKey: 'client-1' }, hostTestAttachParams(null))).toMatchObject({
      ok: true
    })
    checkpoint.mockImplementationOnce(() => {
      throw new Error('reporter unavailable')
    })
    append(1)
    append(2)
    await host.flushStreamedEvents(HOST_TEST_SESSION)
    expect(checkpoint).toHaveBeenCalledTimes(2)
    expect(checkpoint.mock.calls[1]![0].cursor.sequence).toBeGreaterThan(
      checkpoint.mock.calls[0]![0].cursor.sequence
    )
  })
})
