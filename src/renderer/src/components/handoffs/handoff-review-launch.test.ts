// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest'
import type { HandoffDetail } from '../../../../shared/console-handoff-contract'
import { openHandoffReviewSession } from './handoff-review-launch'

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  pickFolder: vi.fn(),
  createProjectGroup: vi.fn(),
  openModal: vi.fn(),
  materialize: vi.fn()
}))
vi.mock('@/store', () => ({ useAppStore: { getState: mocks.getState } }))
vi.mock('../../../../shared/backoffice-connection', () => ({
  resolveBackofficeBaseUrl: () => ({ configured: true, baseUrl: 'https://example.com' })
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values: Record<string, string> = {}) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => values[name] ?? '')
}))
const detail = {
  thread: { id: 'hth_one', title: 'Work', action: 'edit', board_task_id: null },
  files: [],
  entries: [],
  reviews: []
} as unknown as HandoffDetail
const received = (
  files: {
    name: string
    outcome: 'written' | 'unchanged' | 'refused'
    path?: string
    reason?: string
  }[]
) => ({
  ok: true,
  data: {
    manifest: null,
    git: null,
    files: {
      root: '/picked',
      complete: files.every((file) => file.outcome !== 'refused'),
      files: files.map((file) => ({ rel: file.name, sha256: '', size: 1, ...file }))
    }
  }
})
beforeEach(() => {
  vi.resetAllMocks()
  Object.defineProperty(window, 'api', {
    value: {
      repos: { pickFolder: mocks.pickFolder },
      consoleHandoffs: { materialize: mocks.materialize }
    },
    configurable: true
  })
  mocks.pickFolder.mockResolvedValue('/picked')
  mocks.materialize.mockResolvedValue(received([]))
  mocks.createProjectGroup.mockResolvedValue({ id: 'new-group' })
  mocks.getState.mockReturnValue({
    settings: { activeRuntimeEnvironmentId: 'remote' },
    projectGroups: [],
    createProjectGroup: mocks.createProjectGroup,
    openModal: mocks.openModal
  })
})
it.each(['edit', 'continue'] as const)(
  'defaults %s to a local folder group using the existing composer',
  async (mode) => {
    expect(await openHandoffReviewSession(detail, mode)).toBe('')
    expect(mocks.createProjectGroup).toHaveBeenCalledWith('picked', {
      parentPath: '/picked',
      runtimeEnvironmentId: null
    })
    expect(mocks.openModal).toHaveBeenCalledWith(
      'new-workspace-composer',
      expect.objectContaining({
        initialProjectGroupId: 'new-group',
        taskSourceContext: expect.objectContaining({ hostId: 'local' }),
        prefilledNote: expect.stringContaining('Work files:'),
        launchOptions: { submitPrompt: true, chatBypass: true }
      })
    )
  }
)
it('reuses a local group, ignoring an identically named path on a remote host', async () => {
  mocks.getState.mockReturnValue({
    settings: null,
    projectGroups: [
      { id: 'remote', parentPath: '/picked', executionHostId: 'runtime:remote' },
      { id: 'local', parentPath: '/picked', executionHostId: 'local' }
    ],
    createProjectGroup: mocks.createProjectGroup,
    openModal: mocks.openModal
  })
  await openHandoffReviewSession(detail, 'continue')
  expect(mocks.createProjectGroup).not.toHaveBeenCalled()
  expect(mocks.openModal).toHaveBeenCalledWith(
    'new-workspace-composer',
    expect.objectContaining({ initialProjectGroupId: 'local' })
  )
})
it('opens the unchanged worktree composer alternative without a local picker', async () => {
  await openHandoffReviewSession(detail, 'edit', 'worktree')
  expect(mocks.pickFolder).not.toHaveBeenCalled()
  expect(mocks.createProjectGroup).not.toHaveBeenCalled()
  expect(mocks.openModal.mock.calls[0]![1]).not.toHaveProperty('initialProjectGroupId')
})
it('does not create or launch after picker cancellation', async () => {
  mocks.pickFolder.mockResolvedValue(null)
  await openHandoffReviewSession(detail, 'continue')
  expect(mocks.createProjectGroup).not.toHaveBeenCalled()
  expect(mocks.openModal).not.toHaveBeenCalled()
})
it('reports a failed group creation without opening a worktree composer', async () => {
  mocks.createProjectGroup.mockResolvedValue(null)
  expect(await openHandoffReviewSession(detail, 'edit')).toBe(
    'The folder could not be added. Try again.'
  )
  expect(mocks.openModal).not.toHaveBeenCalled()
})
it('saves everything sent into the folder first, and tells the AI where each part is', async () => {
  const file = (name: string) => ({ id: name, name, version: 1, current: true })
  const sent = {
    ...detail,
    files: [file('ads.md'), file('Summary - Ads - 2026-09-18 130924.md'), file('talk.md')],
    entries: [
      {
        kind: 'handoff',
        body: 'Please finish the ads.',
        references: [
          { kind: 'summary-file', ref: 'Summary - Ads - 2026-09-18 130924.md' },
          { kind: 'transcript-file', ref: 'talk.md' }
        ]
      }
    ]
  } as unknown as HandoffDetail
  mocks.materialize.mockResolvedValue(
    received([
      { name: 'ads.md', outcome: 'written', path: '/picked/ads.md' },
      {
        name: 'Summary - Ads - 2026-09-18 130924.md',
        outcome: 'unchanged',
        path: '/picked/Summary - Ads - 2026-09-18 130924.md'
      },
      { name: 'talk.md', outcome: 'refused', reason: 'talk.md already contains different work.' }
    ])
  )
  expect(await openHandoffReviewSession(sent, 'continue')).toBe('')
  expect(mocks.materialize).toHaveBeenCalledWith({
    threadId: 'hth_one',
    workspacePath: '/picked',
    filesOnly: true
  })
  const note = mocks.openModal.mock.calls[0]![1].prefilledNote as string
  expect(note).toContain(
    'Read this first — summary: "/picked/Summary - Ads - 2026-09-18 130924.md"'
  )
  expect(note).toContain('Work files: "/picked/ads.md"')
  expect(note).toContain(
    'Not saved (say so before relying on them): talk.md: talk.md already contains'
  )
  expect(note).toContain('Please finish the ads.')
  expect(note.indexOf('Read this first')).toBeLessThan(note.indexOf('Work files:'))
})
it('starts no session when the work could not be saved into the folder', async () => {
  mocks.materialize.mockResolvedValue({
    ok: false,
    error: { code: 'file_unavailable', message: 'offline' }
  })
  expect(await openHandoffReviewSession(detail, 'continue')).toContain('no session was started')
  expect(mocks.createProjectGroup).not.toHaveBeenCalled()
  expect(mocks.openModal).not.toHaveBeenCalled()
})
it('does not save into a folder for the worktree alternative, which does not exist yet', async () => {
  await openHandoffReviewSession(detail, 'continue', 'worktree')
  expect(mocks.materialize).not.toHaveBeenCalled()
})

it('preserves Jira context after saving files without linking a retired hub card', async () => {
  const linked: HandoffDetail = {
    ...detail,
    thread: {
      ...detail.thread,
      board_task_id: 'btk_retired',
      task_ref: {
        provider: 'jira',
        cloud_id: 'bb6f9191-a21a-4857-b965-32de82dce68b',
        issue_id: '10123',
        issue_key: 'OMR-123',
        project_key: 'OMR'
      }
    }
  }
  expect(await openHandoffReviewSession(linked, 'continue')).toBe('')
  expect(mocks.materialize).toHaveBeenCalled()
  const launch = mocks.openModal.mock.calls[0]![1]
  expect(launch.prefilledNote).toContain('Existing Jira task: OMR-123; cloud')
  expect(launch.prefilledNote).toContain('do not create another task')
  expect(launch.prefilledNote).toContain('Completing this handoff does not complete Jira')
  expect(launch.linkedWorkItem).not.toHaveProperty('hubTaskId')
  expect(launch.linkedWorkItem.url).toBe('https://example.com/a/hth_one')
})
