import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PersistedState } from '../../shared/persisted-state-types'
import type { SessionChain } from '../../shared/session-chain-types'
import type { SessionOutcomeAttempt } from '../../shared/session-outcome-types'
import { proveRun, runAttempt, runSet } from '../../shared/session-run-lifecycle.test-fixture'
import { writeFileDurableSync } from '../durable-file-write'
import { SessionChainPersistence } from '../persistence/loading-store/session-chain-persistence'
import type { WriteSchedulingOperations } from '../persistence/loading-store/write-scheduling'
import type { OrcaRuntimeService } from './omni-runtime'
import { consoleJobActivationReceipt } from './orchestration/console-job-activation-receipt'
import {
  consoleJobDigestFixture,
  consoleJobFixture,
  consoleJobPrincipalFixture
} from './orchestration/console-job-test-fixture'
import { OrchestrationDb } from './orchestration/db'
import type { MessageInsert } from './orchestration/db/messages/message-insert'
import { createHubTaskProjection } from './orchestration/db/tasks/task-store'
import { reconcileLifecycleMessage } from './orchestration/lifecycle-reconciliation'
import { settleSessionOutcomeChain } from './session-outcome-completion'
import {
  sessionOutcomeCoordinatorHandle,
  sessionOutcomeCoordinatorPaneKey
} from './session-outcome-local-launch'
import { SessionOutcomeService } from './session-outcome-service'
import {
  acceptPersistedOutcomeWorkers,
  recoverPersistedOutcomeWorkerAcceptance
} from './session-outcome-worker-acceptance'

const workerPane = 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const cleanups: (() => void)[] = []

function fixture(finite = true, consoleJob = false) {
  const workspace = mkdtempSync(join(tmpdir(), 'outcome-worker-acceptance-'))
  const statePath = join(workspace, 'state.json')
  const state = { sessionChains: [] } as unknown as PersistedState
  const flush = vi.fn(() =>
    writeFileDurableSync(join(workspace, 'state.tmp'), statePath, JSON.stringify(state))
  )
  const persistence = new SessionChainPersistence(
    { state, flushOrThrow: flush },
    {} as WriteSchedulingOperations
  )
  const db = new OrchestrationDb(':memory:')
  cleanups.push(() => {
    db.close()
    rmSync(workspace, { recursive: true, force: true })
  })
  const chain: SessionChain = {
    id: 'chain',
    workspacePath: workspace,
    worktreeId: 'folder:workspace',
    hostId: 'local',
    sourcePaneKey: 'source',
    sourceRowKey: 'row:source',
    auto: true,
    steps: [],
    currentIndex: 0,
    state: 'waiting',
    createdAt: 1,
    updatedAt: 1,
    outcomeSet: runSet()
  }
  const attempt = runAttempt({ state: 'completed' })
  attempt.coordinatorHandle = sessionOutcomeCoordinatorHandle(chain, attempt)
  attempt.coordinatorPaneKey = sessionOutcomeCoordinatorPaneKey(chain, attempt)
  const run = db.createRun({
    objective: 'Programmatic outcome execution',
    coordinatorHandle: attempt.coordinatorHandle,
    coordinatorPaneKey: attempt.coordinatorPaneKey,
    ...(consoleJob
      ? {
          hubTaskId: consoleJobFixture.taskId,
          consoleJob: consoleJobFixture,
          consoleJobPrincipal: consoleJobPrincipalFixture,
          consoleJobActivation: consoleJobActivationReceipt(
            consoleJobFixture,
            consoleJobDigestFixture
          )
        }
      : {})
  })
  const task = consoleJob
    ? createHubTaskProjection(db, {
        runId: run.id,
        hubTaskId: consoleJobFixture.taskId,
        title: 'Produce the outcome artifact'
      })
    : db.createTask({ spec: 'Produce the outcome artifact', runId: run.id })
  const { dispatch } = db.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: Number.MAX_SAFE_INTEGER,
    taskId: task.id,
    startOptions: {
      agent: 'codex',
      ...(finite
        ? {
            completionPolicy: {
              kind: 'release_on_accepted_completion',
              coordinator: { worktreeId: chain.worktreeId, paneKey: attempt.coordinatorPaneKey }
            }
          }
        : {})
    }
  })
  db.prepareStartingWorkerAuthority({
    dispatchId: dispatch.id,
    handle: 'term_worker',
    paneKey: workerPane,
    processIncarnation: 'test:worker:1',
    worktreeId: chain.worktreeId,
    setupState: 'not_applicable',
    effects: [],
    terminalOwnership: 'created',
    hostScope: JSON.stringify({ kind: 'local', hostId: 'local' })
  })
  db.markWorkerDispatchReady(dispatch.id)
  Object.assign(attempt, { taskId: task.id, dispatchId: dispatch.id, runId: run.id })
  chain.outcomeSet!.attempts = [attempt]
  const runtime = {
    getOrchestrationDb: () => db,
    listSessionChains: vi.fn(() => persistence.listSessionChains()),
    replaceSessionChainOutcomesAndFlush: vi.fn((next: SessionChain, expected: number) =>
      persistence.replaceSessionChainOutcomesAndFlush(next, expected)
    )
  } as unknown as OrcaRuntimeService
  const persist = (next = chain) =>
    runtime.replaceSessionChainOutcomesAndFlush(
      next,
      runtime.listSessionChains().find((entry) => entry.id === next.id)?.outcomeSet?.revision ?? 0
    )
  const mail = (extra: Partial<MessageInsert> = {}) =>
    db.insertMessage({
      from: 'term_worker',
      senderPaneKey: workerPane,
      to: `run:${run.id}`,
      runId: run.id,
      type: 'heartbeat',
      subject: 'Working',
      payload: JSON.stringify({ taskId: task.id, dispatchId: dispatch.id }),
      ...extra
    })
  const report = (outcome: 'succeeded' | 'failed' = 'succeeded') => {
    const message = mail({
      type: 'worker_done',
      subject: 'Finished',
      body: 'Artifact saved for the parent.',
      payload: JSON.stringify({ taskId: task.id, dispatchId: dispatch.id, outcome })
    })
    expect(reconcileLifecycleMessage(db, message).action).toBe(
      outcome === 'succeeded' ? 'completed' : 'failed'
    )
    return message
  }
  return {
    db,
    runtime,
    chain,
    attempt,
    run,
    task,
    dispatch,
    flush,
    persist,
    mail,
    report,
    disk: () => JSON.parse(readFileSync(statePath, 'utf8')) as PersistedState,
    resource: () => db.getWorkerTerminalResourceByOwner(dispatch.id)!
  }
}

describe('durable outcome parent accepts finite workers', () => {
  let f: ReturnType<typeof fixture>
  afterEach(() => {
    for (const close of cleanups.splice(0)) {
      close()
    }
    vi.restoreAllMocks()
  })

  it('requests release through the real acknowledgement only after the completed attempt is flushed', () => {
    f = fixture()
    const message = f.report()
    f.persist({
      ...f.chain,
      outcomeSet: { ...f.chain.outcomeSet!, attempts: [{ ...f.attempt, state: 'running' }] }
    })
    expect(f.resource().release_state).toBe('not_requested')
    const acknowledge = f.db.acknowledgeRunDelivery.bind(f.db)
    const ack = vi.spyOn(f.db, 'acknowledgeRunDelivery').mockImplementation((input) => {
      expect(f.disk().sessionChains?.[0]?.outcomeSet?.attempts[0]?.state).toBe('completed')
      return acknowledge(input)
    })
    const service = new SessionOutcomeService(f.runtime, undefined, { now: () => 10 })
    const saved = service.save(f.chain, 1)
    expect(ack).toHaveBeenCalledOnce()
    expect(f.db.getMessageById(message.id)?.read).toBe(1)
    expect(f.resource().release_state).toBe('requested')
    const requestedAt = f.resource().release_requested_at
    acceptPersistedOutcomeWorkers(f.runtime, saved)
    expect(ack).toHaveBeenCalledOnce()
    expect(f.resource().release_requested_at).toBe(requestedAt)
  })

  it('does not acknowledge an unsaved completion when the durable write fails', () => {
    f = fixture()
    const message = f.report()
    f.persist({
      ...f.chain,
      outcomeSet: { ...f.chain.outcomeSet!, attempts: [{ ...f.attempt, state: 'running' }] }
    })
    f.flush.mockImplementationOnce(() => {
      throw new Error('disk unavailable')
    })
    const service = new SessionOutcomeService(f.runtime, undefined, { now: () => 10 })
    expect(() => service.save(f.chain, 1)).toThrow('disk unavailable')
    expect(f.disk().sessionChains?.[0]?.outcomeSet?.attempts[0]?.state).toBe('running')
    recoverPersistedOutcomeWorkerAcceptance(f.runtime, 10)
    expect(f.db.getMessageById(message.id)?.read).toBe(0)
    expect(f.resource().release_state).toBe('not_requested')
  })

  it('leaves workers without an explicit finite policy under manual lifecycle control', () => {
    f = fixture(false)
    const message = f.report()
    acceptPersistedOutcomeWorkers(f.runtime, f.persist())
    expect(f.db.getMessageById(message.id)?.read).toBe(0)
    expect(f.resource().release_state).toBe('not_requested')
  })

  it.each<[string, Partial<SessionOutcomeAttempt>]>([
    ['running', { state: 'running' }],
    ['blocked', { state: 'blocked' }],
    [
      'native continuation',
      {
        nativeContinuation: {
          previousDispatchId: 'previous',
          worktreeId: 'folder:workspace',
          briefSha256: 'a'.repeat(64)
        }
      }
    ],
    [
      'original conversation',
      { conversationTurn: { worktreeId: 'folder:workspace', paneKey: workerPane, kind: 'pty' } }
    ],
    ['manual coordinator', { coordinatorHandle: 'term_person' }],
    ['missing dispatch', { dispatchId: undefined }],
    ['missing task', { taskId: undefined }],
    ['missing Run', { runId: undefined }],
    ['missing coordinator pane', { coordinatorPaneKey: undefined }]
  ])('does not accept a %s attempt', (_name, patch) => {
    f = fixture()
    const message = f.report()
    Object.assign(f.attempt, patch)
    acceptPersistedOutcomeWorkers(f.runtime, f.persist())
    expect(f.db.getMessageById(message.id)?.read).toBe(0)
    expect(f.resource().release_state).toBe('not_requested')
  })

  it.each([
    'remote',
    'legacy',
    'hub',
    'console job',
    'rebound coordinator',
    'rebound pane'
  ] as const)('leaves %s authority to its existing owner', (authority) => {
    f = fixture(true, authority === 'console job')
    const message = f.report()
    if (authority === 'remote') {
      f.chain.hostId = 'remote-host'
    }
    if (authority === 'legacy') {
      f.db.db.prepare('UPDATE runs SET legacy = 1 WHERE id = ?').run(f.run.id)
    }
    if (authority === 'hub') {
      f.db.db.prepare('UPDATE runs SET hub_task_id = ? WHERE id = ?').run('hub-task', f.run.id)
    }
    if (authority === 'rebound coordinator') {
      f.db.db
        .prepare('UPDATE runs SET coordinator_handle = ? WHERE id = ?')
        .run('term_other', f.run.id)
    }
    if (authority === 'rebound pane') {
      f.db.db
        .prepare('UPDATE runs SET coordinator_pane_key = ? WHERE id = ?')
        .run('tab_other:cccccccc-cccc-4ccc-8ccc-cccccccccccc', f.run.id)
    }
    acceptPersistedOutcomeWorkers(f.runtime, f.persist())
    expect(f.db.getMessageById(message.id)?.read).toBe(0)
    expect(f.resource().release_state).toBe('not_requested')
  })

  it('does not convert a failed worker report into a successful parent acceptance', () => {
    f = fixture()
    const message = f.report('failed')
    acceptPersistedOutcomeWorkers(f.runtime, f.persist())
    expect(f.db.getMessageById(message.id)?.read).toBe(0)
    expect(f.resource().release_state).toBe('not_requested')
  })

  it.each(['sender', 'dispatch', 'task', 'provenance'] as const)(
    'requires exact report %s',
    (mismatch) => {
      f = fixture()
      const message = f.report()
      if (mismatch === 'sender') {
        f.db.db
          .prepare('UPDATE messages SET sender_pane_key = ? WHERE id = ?')
          .run('tab_other:cccccccc-cccc-4ccc-8ccc-cccccccccccc', message.id)
      }
      if (mismatch === 'dispatch' || mismatch === 'task') {
        f.db.db.prepare('UPDATE messages SET payload = ? WHERE id = ?').run(
          JSON.stringify({
            taskId: mismatch === 'task' ? 'another-task' : f.task.id,
            dispatchId: mismatch === 'dispatch' ? 'another-dispatch' : f.dispatch.id,
            outcome: 'succeeded'
          }),
          message.id
        )
      }
      if (mismatch === 'provenance') {
        f.db.db
          .prepare('UPDATE tasks SET result = ? WHERE id = ?')
          .run(JSON.stringify({ provenance: 'manual', messageId: message.id }), f.task.id)
      }
      acceptPersistedOutcomeWorkers(f.runtime, f.persist())
      expect(f.db.getMessageById(message.id)?.read).toBe(0)
      expect(f.resource().release_state).toBe('not_requested')
    }
  )

  it('accepts only matching attempt heartbeats alongside its final report', () => {
    f = fixture()
    const heartbeat = f.mail()
    const message = f.report()
    acceptPersistedOutcomeWorkers(f.runtime, f.persist())
    expect(f.db.getMessageById(heartbeat.id)?.read).toBe(1)
    expect(f.db.getMessageById(message.id)?.read).toBe(1)
    expect(f.resource().release_state).toBe('requested')
  })

  it.each<[string, Partial<MessageInsert>]>([
    ['question', { type: 'question' }],
    ['approval gate', { type: 'decision_gate' }],
    ['unrelated status', { type: 'status' }],
    ['different sender', { from: 'term_other' }],
    ['different pane', { senderPaneKey: 'tab_other:cccccccc-cccc-4ccc-8ccc-cccccccccccc' }],
    ['different task', { payload: JSON.stringify({ taskId: 'other', dispatchId: 'other' }) }],
    ['malformed heartbeat', { payload: '{' }]
  ])('does not consume a %s to get to the result', (_name, extra) => {
    f = fixture()
    const message = f.report()
    // Insert after lifecycle reconciliation, which itself retires stale heartbeats.
    const unrelated = f.mail(extra)
    expect(f.db.getMessageById(unrelated.id)?.read).toBe(0)
    acceptPersistedOutcomeWorkers(f.runtime, f.persist())
    expect(f.db.getMessageById(unrelated.id)?.read).toBe(0)
    expect(f.db.getMessageById(message.id)?.read).toBe(0)
    expect(f.resource().release_state).toBe('not_requested')
  })

  it('recovers a saved sealed completion without reopening its plan or acknowledging it twice', () => {
    f = fixture()
    const message = f.report()
    recoverPersistedOutcomeWorkerAcceptance(f.runtime, 0)
    expect(f.db.getMessageById(message.id)?.read).toBe(0)
    const sealed = settleSessionOutcomeChain({
      chain: { ...f.chain, outcomeSet: proveRun(f.chain.outcomeSet!, 'one') },
      current: undefined,
      now: 10,
      held: null
    }).chain
    expect(sealed.outcomeSet?.completion).toBeDefined()
    const saved = f.persist(sealed)
    recoverPersistedOutcomeWorkerAcceptance(f.runtime, 9_999)
    expect(f.resource().release_state).toBe('not_requested')
    recoverPersistedOutcomeWorkerAcceptance(f.runtime, 10_000)
    expect(f.db.getMessageById(message.id)?.read).toBe(1)
    expect(f.resource().release_state).toBe('requested')
    const requestedAt = f.resource().release_requested_at
    recoverPersistedOutcomeWorkerAcceptance(f.runtime, 20_000)
    expect(f.resource().release_requested_at).toBe(requestedAt)
    expect(f.runtime.listSessionChains()).toEqual([saved])
    expect(f.disk().sessionChains).toEqual([saved])
  })

  it('retries acknowledgement after a transient failure using the persisted completion', () => {
    f = fixture()
    const message = f.report()
    f.persist()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(f.db, 'acknowledgeRunDelivery').mockImplementationOnce(() => {
      throw new Error('busy')
    })
    recoverPersistedOutcomeWorkerAcceptance(f.runtime, 0)
    expect(f.db.getMessageById(message.id)?.read).toBe(0)
    expect(f.resource().release_state).toBe('not_requested')
    recoverPersistedOutcomeWorkerAcceptance(f.runtime, 10_000)
    expect(f.db.getMessageById(message.id)?.read).toBe(1)
    expect(f.resource().release_state).toBe('requested')
  })
})
