import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AppChanges from '@/lib/session-organization-app-changes'
import type {
  SessionManageSidebarRow,
  SessionManageRendererRequest
} from '../../../../shared/session-manage-relay'
import { archiveTransferredSessions } from './session-manage-archive'

const mocks = vi.hoisted(() => ({
  rows: [] as SessionManageSidebarRow[],
  archive: vi.fn(),
  recorded: [] as unknown[],
  view: { loaded: true, load: vi.fn(), setArchived: vi.fn(), archiveTransfer: vi.fn() }
}))
vi.mock('sonner', () => ({ toast: vi.fn() }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, text: string) => text }))
vi.mock('@/lib/session-folder-cli-session-ops', () => ({ applyArchiveSessionBatch: mocks.archive }))
vi.mock('@/lib/session-manage-sidebar-rows', () => ({
  buildSessionManageSidebarRows: () => mocks.rows
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('@/store/session-folders', () => ({ useSessionFolders: {} }))
vi.mock('@/store/session-sidebar-view', () => ({
  useSessionSidebarView: { getState: () => mocks.view }
}))

// Why: the change path is proven on real stores elsewhere; here, which change and executor.
vi.mock('@/lib/session-organization-app-changes', async (importOriginal) => {
  const actual = await importOriginal<typeof AppChanges>()
  return {
    ...actual,
    applyRecordedChange: vi.fn(async (change: AppChanges.StoreActionChange) => {
      mocks.recorded.push(change.request)
      try {
        const error = change.act(
          change.request as never,
          {
            view: { getState: () => mocks.view }
          } as never
        )
        return error ? { ok: false, error } : { ok: true }
      } catch (error) {
        return { ok: false, error: (error as Error).message }
      }
    })
  }
})

type ArchiveRequest = Extract<SessionManageRendererRequest, { kind: 'archiveSessions' }>
function request(): ArchiveRequest {
  return {
    kind: 'archiveSessions',
    operationId: 'operation',
    commitToken: 'commit',
    acknowledgedTarget: {
      paneKey: 'target',
      viewKey: 'target',
      worktreeId: 'workspace',
      tabId: 'target-tab',
      kind: 'terminal',
      structuredSessionId: null,
      hostId: null
    },
    reason: 'handed off',
    expiresAt: Date.now() + 10_000,
    targets: [
      {
        paneKey: 'pane',
        viewKey: 'conversation',
        worktreeId: 'workspace',
        tabId: 'tab',
        kind: 'terminal',
        structuredSessionId: null,
        hostId: null
      }
    ]
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.recorded = []
  mocks.view.archiveTransfer.mockImplementation((...args: unknown[]) => mocks.archive(...args))
  mocks.rows = [
    {
      ...request().acknowledgedTarget,
      title: 'Target',
      archived: false,
      hostUnavailable: false,
      launchPending: false,
      shellForeground: false
    } as SessionManageSidebarRow,
    {
      ...request().targets[0],
      archived: false,
      hostUnavailable: false,
      launchPending: false,
      shellForeground: false,
      title: 'Source'
    } as SessionManageSidebarRow
  ]
})

describe('transfer archive commit fence', () => {
  it('returns the exact identities committed together, recorded as one transfer', async () => {
    const input = request()
    expect((await archiveTransferredSessions(input)).archived).toEqual(input.targets)
    expect(mocks.archive).toHaveBeenCalledWith(['conversation'], 'operation', expect.any(Function))
    expect(mocks.recorded).toEqual([
      {
        kind: 'archive',
        targets: [{ sessionKey: 'conversation' }],
        value: true,
        executor: { kind: 'app', feature: 'transfer' },
        evidence: 'transfer operation',
        reason: 'handed off'
      }
    ])
  })

  it('refuses when the archive store throws, and says why', async () => {
    mocks.view.archiveTransfer.mockImplementation(() => {
      throw new Error('A transfer checkpoint changed; no sources were archived.')
    })
    await expect(archiveTransferredSessions(request())).rejects.toThrow('checkpoint changed')
  })

  it('refuses a queued request after its deadline', async () => {
    await expect(
      archiveTransferredSessions({ ...request(), expiresAt: Date.now() })
    ).rejects.toThrow('expired')
    expect(mocks.archive).not.toHaveBeenCalled()
  })

  it('refuses legacy requests lacking the full source identity', async () => {
    const input = request()
    Reflect.deleteProperty(input.targets[0], 'worktreeId')
    await expect(archiveTransferredSessions(input)).rejects.toThrow('complete source identities')
    expect(mocks.archive).not.toHaveBeenCalled()
  })

  it('does not archive a replacement occupying the same pane', async () => {
    mocks.rows[1] = { ...mocks.rows[1], viewKey: 'replacement' }
    await expect(archiveTransferredSessions(request())).rejects.toThrow(
      'changed or became unavailable'
    )
    expect(mocks.archive).not.toHaveBeenCalled()
  })

  it('refuses to archive after the acknowledged target disappears', async () => {
    mocks.rows.shift()
    await expect(archiveTransferredSessions(request())).rejects.toThrow(
      'target changed or disappeared'
    )
    expect(mocks.archive).not.toHaveBeenCalled()
  })

  it('validates the complete set before committing any source', async () => {
    const input = request()
    input.targets.push({ ...input.targets[0], paneKey: 'missing' })
    await expect(archiveTransferredSessions(input)).rejects.toThrow('changed or became unavailable')
    expect(mocks.archive).not.toHaveBeenCalled()
  })
})
