import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from './omni-runtime'
import { readAutomaticWorkerCleanupHold } from './automatic-worker-cleanup-hold'

const f = vi.hoisted(() => ({ rows: vi.fn(), read: vi.fn(), question: vi.fn() }))
vi.mock('../answer-delivery/answer-wait', () => ({ hasOpenQuestion: f.question }))
vi.mock('../session-manage/session-manage-runtime-actions', () => ({ readSidebarRows: f.rows }))
vi.mock('../session-organization/host-organization-instance', () => ({
  sessionOrganizationHostFor: () => ({ ready: Promise.resolve(), read: f.read })
}))
vi.mock('../omni-profiles/profile-storage-paths', () => ({
  getProfileUserDataPath: () => '/tmp/profile'
}))
const config = {
  protectedWorkspacePaths: ['/email'],
  protectedPaneKeys: ['protected-pane'],
  protectStartedToday: true,
  timeZone: 'America/New_York'
}
const target = { worktreeId: 'folder:workspace', paneKey: 'pane' }
function runtime() {
  return {
    getHeadlessSleepSettings: vi.fn(() => ({ automaticSessionCleanupProtection: config })),
    resolveConversationCapacityWorkspace: vi.fn(async () => '/work'),
    getAutomaticCleanupTab: vi.fn(() => ({ id: 'tab', createdAt: Date.now(), isPinned: false })),
    listAutomations: vi.fn(() => []),
    listAutomationRuns: vi.fn(() => []),
    getLastAgentHookRowForPane: vi.fn(() => null)
  }
}
describe('explicit disposable worker protection', () => {
  beforeEach(() => {
    f.question.mockReset().mockReturnValue(false)
    f.rows.mockReset().mockRejectedValue(new Error('No window'))
    f.read.mockReset().mockReturnValue({
      migratedAt: 'today',
      sessions: [
        {
          values: { placement: null },
          pending: []
        }
      ]
    })
  })
  it('permits a declared new worker today with authoritative unfiled owner facts', async () => {
    expect(
      await readAutomaticWorkerCleanupHold(runtime() as unknown as OrcaRuntimeService, target)
    ).toBeNull()
  })
  it.each([false, true])('uses the live folder ancestry for saved=%s', async (saved) => {
    f.rows.mockResolvedValue([
      {
        hostId: 'local',
        worktreeId: target.worktreeId,
        paneKey: target.paneKey,
        folderId: 'ordinary-project-folder',
        saved,
        pinned: false
      }
    ])
    f.read.mockReturnValue({
      migratedAt: 'today',
      sessions: [{ values: { placement: 'ordinary-project-folder' }, pending: [] }]
    })
    expect(
      await readAutomaticWorkerCleanupHold(runtime() as unknown as OrcaRuntimeService, target)
    ).toBe(saved ? 'saved' : null)
  })
  it('does not borrow another host or pane saved status for the headless fallback', async () => {
    f.rows.mockResolvedValue([
      {
        hostId: 'other-host',
        worktreeId: target.worktreeId,
        paneKey: target.paneKey,
        saved: false
      },
      { hostId: 'local', worktreeId: target.worktreeId, paneKey: 'other-pane', saved: false }
    ])
    f.read.mockReturnValue({
      migratedAt: 'today',
      sessions: [{ values: { placement: 'unknown-folder-ancestry' }, pending: [] }]
    })
    expect(
      await readAutomaticWorkerCleanupHold(runtime() as unknown as OrcaRuntimeService, target)
    ).toBe('saved')
  })
  it('holds a newer placement that disagrees with the live row', async () => {
    f.rows.mockResolvedValue([
      {
        hostId: 'local',
        worktreeId: target.worktreeId,
        paneKey: target.paneKey,
        folderId: 'project',
        saved: false
      }
    ])
    f.read.mockReturnValue({
      migratedAt: 'today',
      sessions: [{ values: { placement: 'saved-folder' }, pending: [] }]
    })
    expect(
      await readAutomaticWorkerCleanupHold(runtime() as unknown as OrcaRuntimeService, target)
    ).toBe('protection-unknown')
  })
  it('holds pending organization changes even with a live unsaved row', async () => {
    f.rows.mockResolvedValue([
      { hostId: 'local', worktreeId: target.worktreeId, paneKey: target.paneKey, saved: false }
    ])
    f.read.mockReturnValue({
      migratedAt: 'today',
      sessions: [{ values: { placement: 'project' }, pending: ['move-to-saved'] }]
    })
    expect(
      await readAutomaticWorkerCleanupHold(runtime() as unknown as OrcaRuntimeService, target)
    ).toBe('protection-unknown')
  })
  it('uses the finite-worker baseline when ordinary idle cleanup is unconfigured', async () => {
    const r = runtime()
    r.getHeadlessSleepSettings.mockReturnValue({} as never)
    expect(
      await readAutomaticWorkerCleanupHold(r as unknown as OrcaRuntimeService, target)
    ).toBeNull()
  })
  it.each(['invalid', 'email', 'pane', 'routine', 'saved', 'pinned', 'unknown'])(
    'preserves %s protection',
    async (reason) => {
      const r = runtime()
      let expected = ''
      if (reason === 'invalid') {
        r.getHeadlessSleepSettings.mockReturnValue({
          automaticSessionCleanupProtection: {}
        } as never)
        expected = 'protection-unconfigured'
      } else if (reason === 'email') {
        r.resolveConversationCapacityWorkspace.mockResolvedValue('/email/project')
        expected = 'protected-workspace'
      } else if (reason === 'pane') {
        expected = 'protected-session'
      } else if (reason === 'routine') {
        r.listAutomations.mockReturnValue([{ conversation: { paneKey: 'pane' } }] as never)
        expected = 'routine'
      } else if (reason === 'saved') {
        f.read.mockReturnValue({
          migratedAt: 'today',
          sessions: [{ values: { placement: 'folder' }, pending: [] }]
        })
        expected = 'saved'
      } else if (reason === 'pinned') {
        r.getAutomaticCleanupTab.mockReturnValue({
          id: 'tab',
          createdAt: Date.now(),
          isPinned: true
        })
        expected = 'pinned'
      } else {
        f.read.mockReturnValue({ migratedAt: null, sessions: [] })
        expected = 'protection-unknown'
      }
      expect(
        await readAutomaticWorkerCleanupHold(
          r as unknown as OrcaRuntimeService,
          reason === 'pane' ? { ...target, paneKey: 'protected-pane' } : target
        )
      ).toBe(expected)
    }
  )
  it("holds a worker's close while its own Question is open, only when the caller opts in", async () => {
    const r = runtime()
    r.getLastAgentHookRowForPane.mockReturnValue({
      providerSession: { key: 'claude', id: 'conv-1' }
    } as never)
    f.question.mockReturnValue(true)
    const worker = r as unknown as OrcaRuntimeService
    expect(await readAutomaticWorkerCleanupHold(worker, target)).toBeNull()
    expect(await readAutomaticWorkerCleanupHold(worker, target, { questionWait: true })).toBe(
      'awaiting-answer'
    )
    expect(f.question).toHaveBeenCalledWith({
      paneKey: 'pane',
      worktreeId: 'folder:workspace',
      providerSessionId: 'conv-1'
    })
  })
  it('fails closed on a remote execution workspace or organization mutation', async () => {
    const r = runtime()
    r.resolveConversationCapacityWorkspace.mockRejectedValueOnce(
      new Error('Local workspace required')
    )
    expect(await readAutomaticWorkerCleanupHold(r as unknown as OrcaRuntimeService, target)).toBe(
      'protection-unknown'
    )
    f.read.mockReturnValue({
      migratedAt: 'today',
      sessions: [{ values: { placement: null }, pending: ['change'] }]
    })
    expect(await readAutomaticWorkerCleanupHold(r as unknown as OrcaRuntimeService, target)).toBe(
      'protection-unknown'
    )
  })
})
