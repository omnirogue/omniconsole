import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  context: {
    worktreeId: 'worktree-1',
    worktreePath: '/work/shop',
    runtimeEnvironmentId: null
  } as { worktreeId: string; worktreePath: string; runtimeEnvironmentId: string | null } | null,
  stat: vi.fn(),
  open: vi.fn()
}))

vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('../native-chat/native-chat-file-link', () => ({
  resolveNativeChatFileLinkContext: () => mocks.context
}))
vi.mock('@/runtime/runtime-file-client', () => ({ statRuntimePath: mocks.stat }))
vi.mock('../terminal-pane/terminal-file-open-routing', () => ({
  getTerminalFileContext: () => ({ worktreeId: 'worktree-1' }),
  openDetectedFilePath: mocks.open
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, english: string, values?: Record<string, string | number>) =>
    english.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => String(values?.[key] ?? ''))
}))

import { openLocalWorkflowLocation, workflowLocationProblem } from './local-workflow-open-location'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.context = {
    worktreeId: 'worktree-1',
    worktreePath: '/work/shop',
    runtimeEnvironmentId: null
  }
  mocks.stat.mockResolvedValue({ size: 10, isDirectory: false, mtime: 1 })
})

describe('opening a location an agent reported', () => {
  it('opens a workspace file at its line', async () => {
    await expect(openLocalWorkflowLocation('tab-1', 'src/pay.ts:12')).resolves.toBe('opened')
    expect(mocks.stat).toHaveBeenCalledWith({ worktreeId: 'worktree-1' }, '/work/shop/src/pay.ts')
    expect(mocks.open).toHaveBeenCalledWith('/work/shop/src/pay.ts', 12, null, {
      worktreeId: 'worktree-1',
      worktreePath: '/work/shop',
      runtimeEnvironmentId: null
    })
  })

  it('refuses paths outside the workspace before touching the file system', async () => {
    for (const location of ['../../.ssh/id_rsa:1', '/etc/passwd', '/work/shop-old/a.ts']) {
      await expect(openLocalWorkflowLocation('tab-1', location)).resolves.toBe('outside')
    }
    expect(mocks.stat).not.toHaveBeenCalled()
    expect(mocks.open).not.toHaveBeenCalled()
  })

  it('refuses folders, which on macOS include app bundles', async () => {
    mocks.stat.mockResolvedValue({ size: 0, isDirectory: true, mtime: 1 })
    await expect(openLocalWorkflowLocation('tab-1', 'tools/Updater.app:1')).resolves.toBe('folder')
    expect(mocks.open).not.toHaveBeenCalled()
  })

  it('reports a path that does not exist instead of doing nothing', async () => {
    mocks.stat.mockRejectedValue(new Error('ENOENT'))
    await expect(openLocalWorkflowLocation('tab-1', 'src/gone.ts:4')).resolves.toBe('missing')
    expect(mocks.open).not.toHaveBeenCalled()
    expect(workflowLocationProblem('missing', 'src/gone.ts:4')).toBe(
      "src/gone.ts:4 doesn't exist here."
    )
  })

  it('needs the conversation to belong to a workspace', async () => {
    mocks.context = null
    await expect(openLocalWorkflowLocation('tab-1', 'src/pay.ts')).resolves.toBe('unavailable')
    expect(workflowLocationProblem('opened', 'src/pay.ts')).toBeUndefined()
    expect(workflowLocationProblem('outside', '/etc/passwd')).toBe(
      "/etc/passwd is outside this workspace, so it wasn't opened."
    )
  })
})
