import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildBriefExecutionPrompt } from '../../../../../shared/assisted-brief-execution-prompt'
import { createBriefRecord } from '../../../../../shared/assisted-brief-revisions'
import { currentRevisionStart } from '../../../../../shared/assisted-brief-start'
import type { AssistedBriefRecord } from '../../../../../shared/assisted-brief-types'
import type { AttentionLaunchPlan } from '../../../../../shared/attention-launch-favorites'
import { readSavedBrief, writeSavedBrief } from './assisted-brief-memory'
import type { BriefWorkspace } from './assisted-brief-workspace'

const store = vi.hoisted(() => ({
  state: { workspaceSessionReady: true, tabsByWorktree: {} as Record<string, { id: string }[]> }
}))
const launch = vi.hoisted(() => ({ fn: vi.fn() }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => store.state } }))
vi.mock('../attention-favorite-launch', () => ({ launchAttentionFavorite: launch.fn }))

const { readCurrentBrief, startApprovedBrief } = await import('./assisted-brief-start-launch')

function memoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => void map.set(key, String(value))
  }
}

const SCOPE = '["profile-1"]'
const WORKSPACE: BriefWorkspace = {
  worktreeId: 'repo-1::/work/app',
  workspaceKey: '["repo-1::/work/app","local"]',
  label: 'app',
  kind: 'git',
  worktreePath: '/work/app',
  paired: false
}
const PLAN = {
  favorite: {
    id: 'claude-teams-fable',
    label: 'Claude Teams · Fable',
    agent: 'claude-agent-teams',
    viewMode: 'chat'
  },
  launchPreferences: undefined,
  account: null,
  blockers: [],
  view: { mode: 'chat' },
  detectionPending: false
} as AttentionLaunchPlan

function brief(): AssistedBriefRecord {
  return createBriefRecord({
    briefId: 'brief-1',
    workspaceKey: WORKSPACE.workspaceKey,
    original: { text: 'Research three competitors and summarise their pricing.', attachments: [] },
    drafter: { agent: 'claude', model: 'claude-fable-5-1[1m]', label: 'Claude Teams · Fable' },
    content: {
      outcome: { id: 'o1', text: 'A pricing summary of three competitors', origin: 'request' },
      sections: {
        scope: [],
        constraints: [],
        assumptions: [],
        deliverables: [],
        successChecks: []
      },
      questions: []
    },
    now: 1_000
  })
}

let storage: Storage
const start = (workspace: BriefWorkspace = WORKSPACE) =>
  startApprovedBrief({ storage, scope: SCOPE, workspace, plan: PLAN })
const saved = () => readSavedBrief(storage, SCOPE, WORKSPACE.worktreeId).record!

beforeEach(() => {
  storage = memoryStorage()
  store.state = { workspaceSessionReady: true, tabsByWorktree: {} }
  launch.fn.mockReset()
  launch.fn.mockImplementation(({ tabId }: { tabId: string }) => {
    store.state.tabsByWorktree = { [WORKSPACE.worktreeId]: [{ id: tabId }] }
    return { ok: true, tabId }
  })
  writeSavedBrief(storage, SCOPE, WORKSPACE.worktreeId, brief())
})

describe('starting an approved brief', () => {
  it('saves the start before launching once with the exact approved prompt', () => {
    launch.fn.mockImplementationOnce(({ tabId }: { tabId: string }) => {
      expect(currentRevisionStart(saved())).toMatchObject({ status: 'starting', tabId })
      return { ok: true, tabId }
    })
    const result = start()
    expect(result.kind).toBe('started')
    expect(launch.fn).toHaveBeenCalledTimes(1)
    expect(launch.fn.mock.calls[0][0]).toMatchObject({
      plan: PLAN,
      worktreeId: WORKSPACE.worktreeId,
      request: buildBriefExecutionPrompt(saved())
    })
    expect(currentRevisionStart(saved())?.status).toBe('started')
  })

  it('launches once across a double click', () => {
    expect(start().kind).toBe('started')
    expect(start()).toEqual({ kind: 'refused', reason: 'already-started' })
    expect(launch.fn).toHaveBeenCalledTimes(1)
  })

  it('reconciles an uncertain launch instead of replaying it', () => {
    launch.fn.mockImplementationOnce(() => {
      throw new Error('renderer crashed mid-launch')
    })
    expect(start().kind).toBe('uncertain')
    expect(currentRevisionStart(saved())?.status).toBe('unconfirmed')
    expect(start()).toEqual({ kind: 'refused', reason: 'needs-confirmation' })
    expect(launch.fn).toHaveBeenCalledTimes(1)
  })

  it('settles a start from before a restart when its tab comes back', () => {
    launch.fn.mockImplementationOnce(({ tabId }: { tabId: string }) => {
      store.state.tabsByWorktree = { [WORKSPACE.worktreeId]: [{ id: tabId }] }
      throw new Error('app closed before the result was saved')
    })
    start()
    expect(readCurrentBrief(storage, SCOPE, WORKSPACE).record?.starts[0].status).toBe('started')
    expect(start()).toEqual({ kind: 'refused', reason: 'already-started' })
    expect(launch.fn).toHaveBeenCalledTimes(1)
  })

  it('does not launch while saved tabs are still being restored', () => {
    store.state.workspaceSessionReady = false
    expect(start()).toEqual({ kind: 'refused', reason: 'sessions-restoring' })
    expect(launch.fn).not.toHaveBeenCalled()
  })

  it('lets a definite failure start again under the same operation', () => {
    launch.fn.mockReturnValueOnce({ ok: false, reason: 'launch-failed' })
    expect(start().kind).toBe('not-started')
    const firstTab = launch.fn.mock.calls[0][0].tabId
    expect(start().kind).toBe('started')
    expect(launch.fn.mock.calls[1][0].tabId).toBe(firstTab)
  })

  it('records a paired-host start without claiming it can be found later', () => {
    launch.fn.mockReturnValueOnce({ ok: true, tabId: null })
    expect(start({ ...WORKSPACE, paired: true }).kind).toBe('started')
    expect(currentRevisionStart(saved())).toMatchObject({ status: 'started', verifiable: false })
  })
})
