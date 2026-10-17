import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  SessionFindOwnerResult,
  SessionOwnerCandidate
} from '../../shared/session-owner-types'
import type { SessionPrepBatchView, SessionPrepSteps } from '../../shared/session-prep-types'
import type { SessionPrepHost } from './session-prep-host'

const { findOwner, readRows, prepareTarget, assignRef, workspaceGuard } = vi.hoisted(() => ({
  findOwner: vi.fn(),
  readRows: vi.fn(),
  prepareTarget: vi.fn(),
  assignRef: vi.fn(),
  workspaceGuard: vi.fn()
}))

vi.mock('../runtime/rpc/methods/session-manage-assign-ref-method', () => ({
  assignByRefOnRuntime: assignRef
}))
vi.mock('./session-prep-reuse-workspace', () => ({
  assertSessionPrepReuseWorkspace: workspaceGuard
}))

vi.mock('../session-manage/session-manage-owner-runtime', () => ({
  findSessionOwnerOnRuntime: findOwner,
  assignSessionOnRuntime: vi.fn()
}))
vi.mock('../session-manage/session-manage-runtime-actions', () => ({
  readSidebarRows: readRows
}))
vi.mock('../runtime/rpc/methods/session-manage-support', () => ({
  prepareSessionTarget: prepareTarget,
  settleSessionAction: vi.fn(),
  withPartialAudit: vi.fn()
}))

import { createSessionPrepRuntimeReuse } from './session-prep-reuse-runtime'
import { SessionPrepService } from './session-prep-service'
import { SessionPrepStore } from './session-prep-store'

const source = { worktreeId: 'repo-1::/src', paneKey: 'pane-1', agent: 'claude' as const }
const steps: SessionPrepSteps = {
  plan: async () => ({
    items: [
      {
        title: 'Parser retries',
        ask: 'add parser retries',
        anchor: 'parser retries',
        direct: false,
        changesCode: false
      },
      {
        title: 'Parser tests',
        ask: 'add parser tests',
        anchor: 'parser tests',
        direct: false,
        changesCode: false
      }
    ],
    dropped: []
  }),
  prepare: async ({ item }) => ({
    title: item.title,
    outcome: item.ask,
    doneWhen: ['tests pass'],
    decided: [],
    references: [],
    constraints: [],
    assumptions: [],
    blockingQuestion: null,
    changesCode: false
  }),
  revise: async ({ fields }) => fields,
  gate: async () => ({ pass: true, failures: [], ask: null, scores: {}, judge: 'deterministic' }),
  render: ({ fields }) => `RENDER:${fields.outcome}`,
  renderDirect: ({ item }) => `DIRECT:${item.ask}`
}

function host(): SessionPrepHost & { sessions: unknown[] } {
  const sessions: unknown[] = []
  const repo = {
    selector: 'id:repo-1',
    name: 'App',
    id: 'repo-1',
    path: '/src',
    isFolder: false,
    isRemote: false
  }
  return {
    sessions,
    resolveWorktree: async () => ({
      path: '/src',
      repoId: 'repo-1',
      isFolder: false,
      isRemote: false
    }),
    listRepos: () => [repo],
    resolveRepo: (selector) => (selector === 'id:repo-1' ? repo : null),
    createWorktreeWithAgent: async () => ({ worktreeId: 'repo-1::/wt' }),
    createAgentSessionIn: async (args) => {
      sessions.push(args)
      return { tabId: `tab-${sessions.length}`, paneKey: `new-pane-${sessions.length}` }
    },
    worktreeExistsByName: async () => false,
    findWorktreeIdByName: async () => null,
    isAgentEnabled: () => true,
    fileSession: async () => ({ path: 'Launch' }),
    createBatchFolder: async () => ({ id: 'batch-folder', path: 'Launch' })
  }
}

async function setup(itemCount = 2) {
  const used = host()
  const planSteps =
    itemCount === 2
      ? steps
      : { ...steps, plan: async () => ({ items: [stepsPlan[0]!], dropped: [] }) }
  const store = new SessionPrepStore(await mkdtemp(join(tmpdir(), 'session-prep-runtime-reuse-')))
  const reuse = createSessionPrepRuntimeReuse({} as never)
  const service = new SessionPrepService({ host: used, steps: () => planSteps, store, reuse })
  await service.start()
  const { batchId } = service.request({ text: 'parser work', source, context: '' })
  return { service, host: used, store, batchId }
}

const stepsPlan = [
  {
    title: 'Parser retries',
    ask: 'add parser retries',
    anchor: 'parser retries',
    direct: false,
    changesCode: false
  }
]

async function until(
  service: SessionPrepService,
  batchId: string,
  done: (view: SessionPrepBatchView) => boolean
): Promise<SessionPrepBatchView> {
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    const view = service.get(batchId)
    if (done(view)) {
      return view
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`batch still ${JSON.stringify(service.get(batchId))}`)
}

const owner: SessionOwnerCandidate = {
  paneKey: 'owner-pane',
  tabId: 'tab-owner',
  title: 'Parser editor',
  folder: '/src',
  worktreePath: '/src',
  state: 'working',
  light: false,
  load: 'working',
  signals: ['file-conflict'],
  conflictFiles: ['src/parser.ts'],
  related: null,
  duplicate: null,
  goal: null
} as const

function result(
  disposition: SessionFindOwnerResult['disposition'],
  overrides: Partial<SessionFindOwnerResult> = {}
): SessionFindOwnerResult {
  return {
    disposition,
    launchNew:
      disposition === 'launch-new' ||
      disposition === 'coverage-incomplete' ||
      disposition === 'busy-related',
    reason:
      disposition === 'coverage-incomplete'
        ? 'Remote ownership could not be verified'
        : 'File owner found',
    owner:
      disposition === 'coverage-incomplete' || disposition === 'launch-new' ? undefined : owner,
    taskFiles: ['src/parser.ts'],
    candidates: [],
    unchecked: [],
    ...overrides
  }
}

describe('session prep runtime reuse integration', () => {
  beforeEach(() => {
    findOwner.mockReset()
    readRows.mockReset().mockResolvedValue([])
    prepareTarget.mockReset()
    assignRef.mockReset().mockResolvedValue({})
    workspaceGuard.mockReset().mockResolvedValue(undefined)
  })

  it('keeps an excluded busy file owner as a conflict hold instead of launching beside it', async () => {
    findOwner.mockImplementation(async (_runtime, _rows, input) =>
      input.exclude.has(owner.paneKey) ? result('conflict-owner-busy') : result('duplicate')
    )
    const { service, host: used, batchId } = await setup()
    const view = await until(
      service,
      batchId,
      (value) => value.items[1]?.state === 'awaiting-reuse'
    )
    expect(view.items.map((item) => item.reuse?.kind)).toEqual(['duplicate', 'conflict-busy'])
    expect(findOwner.mock.calls[1]?.[2].exclude).toContain(owner.paneKey)
    expect(findOwner.mock.calls[1]?.[2].conflictExclude).toContain(owner.paneKey)
    expect(findOwner.mock.calls[1]?.[2].conflictExclude).not.toContain('pane-1')
    expect(used.sessions).toHaveLength(0)
  })

  it('keeps judge-limit coverage visible but still permits ordinary new work', async () => {
    findOwner.mockResolvedValue(
      result('coverage-incomplete', {
        reason: 'No owner found, but a candidate was unjudged',
        unchecked: [
          {
            paneKey: 'extra-pane',
            title: 'Sixth session',
            reason: 'not judged because the session-owner limit is 5'
          }
        ]
      })
    )
    const { service, host: used, batchId } = await setup(1)
    const view = await until(service, batchId, (value) => value.state === 'done')
    expect(view.items[0]).toMatchObject({
      state: 'launched',
      note: 'Ownership coverage is incomplete: No owner found, but a candidate was unjudged; Sixth session: not judged because the session-owner limit is 5'
    })
    expect(used.sessions).toHaveLength(1)
  })

  it('holds a busy-related owner when an unavailable same-file owner remains unknown', async () => {
    findOwner.mockResolvedValue(
      result('busy-related', {
        unchecked: [
          {
            paneKey: null,
            title: 'Remote editor',
            reason:
              'excluded session file overlap is unknown because its execution host cannot be inspected',
            risk: 'possible-file-conflict'
          }
        ]
      })
    )
    const { service, host: used, batchId } = await setup(1)
    const view = await until(service, batchId, (value) => value.state === 'done')
    expect(view.items[0]).toMatchObject({
      state: 'failed',
      note: 'Not launched: Ownership coverage is incomplete: File owner found; Remote editor: excluded session file overlap is unknown because its execution host cannot be inspected'
    })
    expect(used.sessions).toHaveLength(0)
  })

  it('holds judge-failure launch-new when the unavailable owner may edit the task files', async () => {
    findOwner.mockResolvedValue(
      result('launch-new', {
        reason: 'JEV could not judge any owner',
        unchecked: [
          {
            paneKey: null,
            title: 'Remote editor',
            reason: 'its host cannot be reached',
            risk: 'possible-file-conflict'
          }
        ]
      })
    )
    const { service, host: used, batchId } = await setup(1)
    const view = await until(service, batchId, (value) => value.state === 'done')
    expect(view.items[0]).toMatchObject({
      state: 'failed',
      note: expect.stringContaining('Remote editor: its host cannot be reached')
    })
    expect(used.sessions).toHaveLength(0)
  })

  it('keeps a created workspace excluded while still discovering conflicts in other panes', async () => {
    const reuse = createSessionPrepRuntimeReuse({} as never)
    readRows.mockResolvedValue([
      { paneKey: 'source-pane', worktreeId: 'repo-1::/source' },
      { paneKey: 'new-pane', worktreeId: 'repo-1::/new-worktree' },
      { paneKey: 'other-owner', worktreeId: 'repo-1::/other' }
    ])
    findOwner.mockResolvedValue(result('conflict-owner-busy'))
    await reuse.find({
      sourcePaneKey: 'source-pane',
      task: 'fix parser',
      prompt: 'fix parser',
      files: ['src/parser.ts'],
      scope: { repoId: 'repo-1' },
      exclude: new Set(['source-pane']),
      excludeWorktreeIds: ['repo-1::/new-worktree']
    })
    const query = findOwner.mock.calls[0]?.[2]
    expect(query.exclude).toContain('new-pane')
    expect(query.conflictExclude).toContain('new-pane')
    expect(query.exclude).not.toContain('other-owner')
  })

  it('holds when an assignment dry run fails while file-conflict coverage is unknown', async () => {
    const reuse = createSessionPrepRuntimeReuse({} as never)
    readRows.mockResolvedValue([{ paneKey: 'source-pane', folderId: null }])
    findOwner.mockResolvedValue(
      result('assign', {
        unchecked: [
          {
            paneKey: null,
            title: 'Remote editor',
            reason: 'workspace status is unavailable',
            risk: 'possible-file-conflict'
          }
        ]
      })
    )
    prepareTarget.mockRejectedValue(new Error('owner became busy'))
    await expect(
      reuse.find({
        sourcePaneKey: 'source-pane',
        task: 'fix parser',
        prompt: 'fix parser',
        files: ['src/parser.ts'],
        scope: { repoId: 'repo-1' },
        exclude: new Set(['source-pane'])
      })
    ).resolves.toMatchObject({ hold: true, note: expect.stringContaining('Remote editor') })
  })

  it.each([
    ['judge limit overflow', 'not judged because the session-owner limit is 5'],
    ['transcript search gap', 'transcripts were not searched (not available)']
  ])('keeps %s as a note while allowing launch-new', async (_case, uncertainty) => {
    findOwner.mockResolvedValue(
      result('launch-new', {
        reason: `No match found; ${uncertainty}`,
        unchecked: uncertainty.startsWith('not judged')
          ? [{ paneKey: 'extra-pane', title: 'Sixth session', reason: uncertainty }]
          : []
      })
    )
    const { service, host: used, batchId } = await setup(1)
    const view = await until(service, batchId, (value) => value.state === 'done')
    expect(view.items[0]?.state).toBe('launched')
    expect(view.items[0]?.note).toContain(uncertainty)
    expect(used.sessions).toHaveLength(1)
  })
  it.each(['archived', 'exited', 'closed'] as const)(
    'offers a related local %s conversation before launching; only the click resumes',
    async (kind) => {
      const ref = 'claude:12345678-1234-1234-1234-123456789abc@local'
      findOwner.mockResolvedValue(
        result(kind === 'archived' ? 'unarchive-and-continue' : 'resume', {
          owner: undefined,
          pastOwner: {
            ref,
            kind,
            title: 'Bank work with Sal override and skip-permissions',
            paneKey: null,
            cwd: '/src',
            archiveKind: null,
            transcriptPath: '/transcript',
            lastActivityAt: 1,
            related: 0.99,
            duplicate: 0.1,
            finished: false,
            links: [],
            goal: 'parser retries'
          }
        })
      )
      const { service, host: used, batchId } = await setup(1)
      const view = await until(
        service,
        batchId,
        (value) => value.items[0]?.state === 'awaiting-reuse'
      )
      expect(view.items[0]?.reuse).toMatchObject({ kind: 'assign' })
      expect(used.sessions).toHaveLength(0)
      expect(findOwner.mock.calls[0]?.[2].pastWork).toBe(true)
      expect(assignRef).toHaveBeenCalledTimes(1)
      expect(assignRef.mock.calls[0]?.[1]).toMatchObject({ ref, dryRun: true })
      await service.decideReuse(batchId, 0, 'assign')
      expect(assignRef.mock.calls[1]?.[1]).toMatchObject({ ref, dryRun: false })
      expect(workspaceGuard).toHaveBeenCalledTimes(2)
      const beforeResume = assignRef.mock.calls[1]?.[3]
      await beforeResume('/actual-transcript-workspace')
      expect(workspaceGuard).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.any(Array),
        expect.objectContaining({ cwd: '/src' }),
        '/actual-transcript-workspace'
      )
      expect(service.get(batchId).items[0]?.state).toBe('assigned')
    }
  )

  it('does not resume a related past conversation on a different host', async () => {
    findOwner.mockResolvedValue(
      result('resume', {
        owner: undefined,
        pastOwner: {
          ref: 'claude:12345678-1234-1234-1234-123456789abc@remote',
          kind: 'closed'
        } as never
      })
    )
    const { service, host: used, batchId } = await setup(1)
    const view = await until(service, batchId, (value) => value.state === 'done')
    expect(view.items[0]).toMatchObject({
      state: 'failed',
      note: expect.stringContaining('not on this computer')
    })
    expect(assignRef).not.toHaveBeenCalled()
    expect(used.sessions).toHaveLength(0)
  })
})
