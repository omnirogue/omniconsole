import { vi, type Mock } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OrchestrationDb } from '../orchestration/db'
import type { OrcaRuntimeService } from '../omni-runtime'
import { captureWorkflowOwner } from './workflow-owner-claim'
import { WorkflowScriptSlots } from './workflow-script-slots'
import { LocalWorkflowHost } from './local-workflow-host'
import { createLocalWorkflowGraphDraft } from '../../../shared/local-workflow-draft'
import { workflowTemplate } from '../../../shared/workflow-graph-templates'
import type { LocalWorkflowSeatCatalog } from '../../../shared/local-workflow-seats'
import type {
  LocalWorkflowChangedEvent,
  LocalWorkflowStartRequest
} from '../../../shared/local-workflow-rpc'
import type { WorkflowAttemptLaunch } from './workflow-durable-call'
import type { WorkflowLiveObserver } from './workflow-live-observer'
import type { LocalWorkflowHostOptions } from './local-workflow-host-options'

const opened: OrchestrationDb[] = []
const directories: string[] = []

export async function closeHostFixtures(): Promise<void> {
  opened.splice(0).forEach((db) => db.close())
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
}

export async function hostTempDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix))
  directories.push(path)
  return path
}

export function catalogEntry(
  agent: LocalWorkflowSeatCatalog['agent'],
  lineage: LocalWorkflowSeatCatalog['models'][number]['lineage']
): LocalWorkflowSeatCatalog {
  return {
    agent,
    accountId: `${agent}-account`,
    accountLabel: agent,
    accountHome: `/accounts/${agent}`,
    policyRevision: 'test-v1',
    models: [
      {
        catalog: { id: 'model', label: 'Model', isDefault: true, options: [] },
        resolvedModelId: `${agent}-concrete`,
        lineage
      },
      // Discover's Scout and Find name Haiku 5.5, as the real Claude catalog offers it.
      ...(agent === 'claude'
        ? [
            {
              catalog: { id: 'claude-haiku-5-5', label: 'Haiku 5.5', options: [] },
              resolvedModelId: 'claude-haiku-5-5',
              lineage
            }
          ]
        : [])
    ]
  }
}

export const hostCatalog: LocalWorkflowSeatCatalog[] = [
  catalogEntry('claude', 'anthropic'),
  catalogEntry('codex', 'openai'),
  catalogEntry('grok', 'xai')
]

/** A current Council start: the Council graph over every host route, the workspace read-only. */
export function hostRequest(
  worktree = 'workspace-a',
  conversationId = 'conversation-a'
): LocalWorkflowStartRequest {
  const draft = createLocalWorkflowGraphDraft({
    prompt: 'Question',
    concurrency: 2,
    graph: {
      spec: workflowTemplate('council', ['claude', 'codex', 'grok']),
      team: hostCatalog.map(({ agent, accountId }, index) => ({
        id: `seat-${index + 1}`,
        agent,
        accountId
      }))
    }
  })
  return { worktree, conversationId, requestId: 'request-1', preset: 'council', draft }
}

/** Legacy structured envelopes, which every provider parser still accepts. */
export function nativeResult(input: Parameters<WorkflowAttemptLaunch>[0], agent: string) {
  const { call, attemptId } = input
  const value = call.id.startsWith('discover/')
    ? { findings: [], omittedCount: 0, omissionReason: '' }
    : { markdown: 'Supported answer', sources: [], disagreements: [] }
  const usage = { input_tokens: 10, output_tokens: 2 }
  const stdout =
    agent === 'codex'
      ? [
          { type: 'thread.started', thread_id: attemptId },
          { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(value) } },
          { type: 'turn.completed', usage }
        ]
          .map((row) => JSON.stringify(row))
          .join('\n')
      : JSON.stringify(
          agent === 'claude'
            ? {
                type: 'result',
                subtype: 'success',
                is_error: false,
                session_id: attemptId,
                structured_output: value,
                modelUsage: { 'claude-concrete': {} },
                usage
              }
            : {
                stopReason: 'end_turn',
                sessionId: attemptId,
                requestId: attemptId,
                structuredOutput: value,
                modelUsage: { 'grok-concrete': {} },
                usage
              }
        )
  return {
    result: { code: 0, signal: null, timedOut: false, stdout, stderr: '' },
    receipt: { attemptId, processReceiptRef: attemptId, liveness: 'exited' as const }
  }
}

export async function hostFixture(
  options: {
    /** Fails this call's first N launches with an unparseable result. */
    fail?: { callId: string; times: number }
    seatCatalog?: LocalWorkflowSeatCatalog[]
    path?: string
    launchBarrier?: Promise<void>
    notify?: (event: LocalWorkflowChangedEvent) => void
    onSettled?: LocalWorkflowHostOptions['onSettled']
    /** Gives the host a working-agent service, as the app does. */
    working?: boolean
    /** Places every Start as the app's fleet placement would; absent, runs are not placed. */
    place?: LocalWorkflowHostOptions['place']
    dispatch?: LocalWorkflowHostOptions['dispatch']
    preflight?: LocalWorkflowHostOptions['preflight']
  } = {}
) {
  const db = new OrchestrationDb(':memory:')
  opened.push(db)
  const owner = await captureWorkflowOwner('test-host')
  const path = options.path ?? (await hostTempDirectory('omni-workflow-host-'))
  const launches: Mock<(callId: string) => void> = vi.fn()
  let failures = 0
  const hostOptions = {
    db: db.db,
    owner,
    slots: new WorkflowScriptSlots(2),
    resolve: async ({ worktree }: { worktree: string }) => ({
      id: worktree,
      path,
      label: worktree
    }),
    catalog: async () => structuredClone(options.seatCatalog ?? hostCatalog),
    listScope: async () => [],
    freezeScope: async () => ({ evidence: '', sources: [], coverage: [] }),
    attestNativeResult: async () => {},
    notify: options.notify,
    ...(options.onSettled ? { onSettled: options.onSettled } : {}),
    ...(options.working ? { working: { db, runtime: {} as OrcaRuntimeService } } : {}),
    ...(options.place ? { place: options.place } : {}),
    ...(options.dispatch ? { dispatch: options.dispatch } : {}),
    ...(options.preflight ? { preflight: options.preflight } : {}),
    launch:
      (
        snapshot: { seats: { id: string; agent: string }[] },
        _id: string,
        _fence: number,
        observer: WorkflowLiveObserver
      ) =>
      async (input: Parameters<WorkflowAttemptLaunch>[0]) => {
        launches(input.call.id)
        observer.starting(input.call.id, input.attemptId)
        input.recordLaunch(input.attemptId)
        observer.spawned(input.call.id, input.attemptId, 1_000)
        observer.update(input.call.id, input.attemptId, {
          activity: 'Reading src/app.ts',
          text: 'Thinking about the cache',
          tokens: { input: 10, output: 2 }
        })
        await options.launchBarrier
        observer.exited(input.call.id, input.attemptId, 2_000)
        const result = nativeResult(
          input,
          snapshot.seats.find((seat) => seat.id === input.call.seatId)!.agent
        )
        if (input.call.id === options.fail?.callId && failures < options.fail.times) {
          failures += 1
          return { ...result, result: { ...result.result, stdout: '{invalid native result' } }
        }
        return result
      }
  }
  return {
    db,
    owner,
    path,
    launches,
    host: new LocalWorkflowHost(hostOptions),
    restored: () => new LocalWorkflowHost(hostOptions)
  }
}

export async function waitForState(
  f: Awaited<ReturnType<typeof hostFixture>>,
  executionId: string,
  states: string[]
): Promise<void> {
  await vi.waitFor(
    () => {
      const row = f.db.db
        .prepare('SELECT state FROM local_workflow_executions WHERE id=?')
        .get(executionId) as { state: string }
      if (!states.includes(row.state)) {
        throw new Error(`Workflow is ${row.state}`)
      }
    },
    { timeout: 5_000 }
  )
}
