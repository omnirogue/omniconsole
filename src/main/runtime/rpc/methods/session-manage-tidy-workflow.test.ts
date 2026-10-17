import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionManageSidebarRow } from '../../../../shared/session-manage-relay'
import type { SessionTidyResult } from '../../../../shared/session-manage-types'
import type { WorkflowRunState } from '../../../../shared/session-workflow-anchor'
import { sidebarRow } from '../../../session-manage/session-manage-test-fixtures'
import type { RpcContext } from '../core'

type RunStatus = WorkflowRunState | 'missing' | 'unavailable'

/**
 * Apply-level (C6 / A6): `omni session tidy --apply` and `--delete --apply` over pane-less
 * workflow anchors, with the real observation, plan and re-check. Only the window's rows, the
 * controller's run records and the existing archive/delete mutation are stood in for.
 */
const state = vi.hoisted(() => ({
  rows: [] as SessionManageSidebarRow[],
  /** Each run's record as its controller answers it, read by read; the last answer repeats. */
  runs: new Map<string, RunStatus[]>(),
  /** Every call the controller received: reads only, ever. */
  controllerCalls: [] as string[],
  mutate: vi.fn(async (_context: unknown, _params: unknown) => ({ summary: 'Done' }))
}))

// Why: no review or Question waits on these sessions; answer-wait.test.ts covers the reads.
vi.mock('../../../answer-delivery/answer-wait', () => ({
  answerWaitKeeper: () => () => null,
  agentAnswerWaitRefusal: () => null
}))
vi.mock('../../../session-manage/session-manage-runtime-actions', () => ({
  readSidebarRows: async () => state.rows
}))
vi.mock('../../../session-manage/session-manage-runtime-sources', async () => {
  const { observeSources } = await import('../../../session-manage/session-manage-test-fixtures')
  // Why no pane: these rows have none, so any pane fallback would call them unverifiable.
  return { createRuntimeObserveSources: () => observeSources({ resolvePane: () => null }) }
})
vi.mock('./session-folders', () => ({ mutateSessionFolders: state.mutate }))
vi.mock('./session-manage-support', () => ({
  actorFor: () => ({ kind: 'cli' }),
  recordSessionAction: vi.fn()
}))

const { SESSION_MANAGE_TIDY_METHOD } = await import('./session-manage-tidy-method')
const { setSessionWorkflowRunReaderFactory } =
  await import('../../../session-manage/session-manage-workflow-runtime')

// The controller, as the workflow RPC module registers it: it answers reads and nothing else.
setSessionWorkflowRunReaderFactory(() => async (_row, ref) => {
  state.controllerCalls.push(`read ${ref.runId}`)
  const answers = state.runs.get(ref.runId) ?? ['missing']
  const status = answers.length > 1 ? answers.shift()! : answers[0]!
  return { status }
})

const context = {
  runtime: {
    getRuntimeId: () => 'runtime-1',
    getArtifactApiOrigin: () => null,
    listSessionChains: () => [],
    listBackgroundRuntimeOwnedTerminals: () => null
  }
} as unknown as RpcContext

function run(params: Record<string, unknown>): Promise<SessionTidyResult> {
  return SESSION_MANAGE_TIDY_METHOD.handler(params, context) as Promise<SessionTidyResult>
}

function addWorkflow(tabId: string, runId: string, answers: RunStatus[]): void {
  state.rows.push(
    sidebarRow({
      rowKey: `["local","repo::/w","${tabId}"]`,
      viewKey: `["local","repo::/w","${tabId}"]`,
      paneKey: null,
      tabId,
      title: `Council ${tabId}`,
      agent: 'Council',
      // What the window last read is stale on purpose: the controller decides.
      workflow: { controller: 'local', preset: 'council', runId, status: 'unknown' }
    })
  )
  state.runs.set(runId, answers)
}

function ops(): Record<string, unknown>[] {
  return state.mutate.mock.calls.map((call) => (call[1] as { op: Record<string, unknown> }).op)
}

beforeEach(() => {
  state.rows = []
  state.runs.clear()
  state.controllerCalls = []
  state.mutate.mockClear()
})

describe('session tidy --apply on workflow anchors', () => {
  it('archives a verified-finished anchor without --unverified, by its controller and run', async () => {
    addWorkflow('tab-done', 'execution-done', ['done'])
    addWorkflow('tab-running', 'execution-running', ['running'])
    const result = await run({ apply: true, request: 'clean up the sessions' })

    expect(ops()).toEqual([
      {
        kind: 'archiveSession',
        tabId: 'tab-done',
        workflow: { controller: 'local', runId: 'execution-done' },
        archived: true
      }
    ])
    // Why: an absent pane is omitted, never sent as undefined or null.
    expect(Object.hasOwn(ops()[0]!, 'paneKey')).toBe(false)
    expect(result.applied).toEqual({ archived: 1, skipped: 0, failed: 0 })
    expect(result.rows.find((row) => row.tabId === 'tab-done')).toMatchObject({
      outcome: 'archived',
      workflow: { controller: 'local', runId: 'execution-done' }
    })
    expect(result.rows.find((row) => row.tabId === 'tab-running')).toMatchObject({
      action: 'skip',
      group: 'workflow-active'
    })
    // Run history kept and nothing cancelled: the controller was only ever read.
    expect(state.controllerCalls.every((call) => call.startsWith('read '))).toBe(true)
  })

  it('closes a separate verified-finished anchor with --delete --apply, without --unverified', async () => {
    addWorkflow('tab-finished', 'execution-finished', ['failed'])
    addWorkflow('tab-draft', 'unused', [])
    state.rows[1] = {
      ...state.rows[1]!,
      launchPending: true,
      workflow: { controller: 'local', preset: 'council', runId: null, status: 'draft' }
    }
    const result = await run({ delete: true, apply: true, request: 'delete finished sessions' })

    expect(ops()).toEqual([
      {
        kind: 'deleteSession',
        tabId: 'tab-finished',
        workflow: { controller: 'local', runId: 'execution-finished' }
      }
    ])
    expect(result.applied).toEqual({ archived: 0, deleted: 1, skipped: 0, failed: 0 })
    expect(result.rows.find((row) => row.tabId === 'tab-draft')).toMatchObject({
      action: 'skip',
      group: 'workflow-draft'
    })
    expect(state.controllerCalls.every((call) => call.startsWith('read '))).toBe(true)
  })

  it('retains an anchor whose run revalidates as active just before removal', async () => {
    addWorkflow('tab-resumed', 'execution-resumed', ['done', 'running'])
    for (const params of [
      { apply: true, request: 'clean up' },
      { delete: true, apply: true, request: 'delete them' }
    ]) {
      state.runs.set('execution-resumed', ['done', 'running'])
      state.mutate.mockClear()
      const result = await run(params)
      expect(state.mutate).not.toHaveBeenCalled()
      expect(result.rows[0]).toMatchObject({ outcome: 'skipped' })
      expect(result.rows[0]!.outcomeReason).toContain('Its workflow run is running')
    }
  })

  it('needs --unverified for run not found and status unavailable, then removes only rows', async () => {
    addWorkflow('tab-missing', 'execution-missing', ['missing'])
    addWorkflow('tab-unread', 'execution-unread', ['unavailable'])
    const archive = await run({ apply: true, request: 'clean up' })
    expect(state.mutate).not.toHaveBeenCalled()
    expect(archive.rows.map((row) => row.group)).toEqual([
      'workflow-run-not-found',
      'workflow-status-unavailable'
    ])
    const plain = await run({ delete: true, apply: true, request: 'delete them' })
    expect(state.mutate).not.toHaveBeenCalled()
    expect(plain.rows.every((row) => row.action === 'skip')).toBe(true)

    await run({ delete: true, unverified: true, apply: true, request: 'delete them' })
    expect(ops()).toEqual([
      {
        kind: 'deleteSession',
        tabId: 'tab-missing',
        workflow: { controller: 'local', runId: 'execution-missing' },
        unverified: true
      },
      {
        kind: 'deleteSession',
        tabId: 'tab-unread',
        workflow: { controller: 'local', runId: 'execution-unread' },
        unverified: true
      }
    ])
  })

  it('takes --include by the anchor’s tab in ordinary tidy too', async () => {
    addWorkflow('tab-done', 'execution-done', ['done'])
    await expect(run({ include: ['tab-done'] })).resolves.toMatchObject({ dryRun: true })
  })
})
