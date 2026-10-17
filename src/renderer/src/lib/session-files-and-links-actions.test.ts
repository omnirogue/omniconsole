import { beforeEach, describe, expect, it, vi } from 'vitest'
const fixture = vi.hoisted(() => ({
  context: { connectionId: undefined as string | undefined },
  openHttpLink: vi.fn(),
  openFilePath: vi.fn(),
  openInFileManager: vi.fn()
}))
vi.mock('@/components/terminal-pane/terminal-file-open-routing', () => ({
  openDetectedFilePath: vi.fn()
}))
vi.mock('@/lib/file-preview', () => ({ getWorkspaceFilePreviewPlan: vi.fn() }))
vi.mock('@/lib/http-link-routing', () => ({ openHttpLink: fixture.openHttpLink }))
vi.mock('@/lib/workspace-file-host-routing', () => ({
  buildWorkspaceFileContextForFile: () => fixture.context,
  canClientOsOpenWorkspaceFile: (context: { connectionId?: string }) => !context.connectionId
}))
vi.mock('@/runtime/runtime-file-client', () => ({ runtimePathExists: vi.fn() }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))
import {
  sessionFilesAndLinksActions as actions,
  canOpenSessionUrlExternally,
  sessionLinkOwner
} from './session-files-and-links-actions'
beforeEach(() => {
  vi.clearAllMocks()
  fixture.context.connectionId = undefined
  vi.stubGlobal('window', {
    api: {
      shell: { openFilePath: fixture.openFilePath, openInFileManager: fixture.openInFileManager }
    }
  })
})
describe('session preview routes', () => {
  it('retains the session SSH owner even when the workspace is local', () => {
    actions.openUrlInApp('http://localhost:3000', 'local-workspace', 'ssh:server')
    expect(fixture.openHttpLink).toHaveBeenCalledWith(
      'http://localhost:3000',
      expect.objectContaining({
        sourceOwner: { kind: 'ssh', connectionId: 'server' },
        allowRemoteInApp: true
      })
    )
    expect(canOpenSessionUrlExternally('http://localhost:3000', 'ssh:server')).toBe(false)
    expect(sessionLinkOwner(null)).toEqual({ kind: 'unknown' })
  })
  it('retains paired ownership and allows external public links only', () => {
    actions.openUrlInApp('http://localhost:3000', 'workspace', 'runtime:paired')
    expect(fixture.openHttpLink).toHaveBeenCalledWith(
      'http://localhost:3000',
      expect.objectContaining({ sourceOwner: { kind: 'runtime', runtimeEnvironmentId: 'paired' } })
    )
    actions.openUrlInSystemBrowser('http://localhost:3000', 'runtime:paired')
    expect(fixture.openHttpLink).toHaveBeenCalledTimes(1)
    expect(canOpenSessionUrlExternally('https://example.vercel.app', 'runtime:paired')).toBe(true)
  })
  it('never sends a remote path to local OS openers', () => {
    fixture.context.connectionId = 'server'
    const target = { worktreeId: 'workspace', worktreePath: '/remote', runtimeEnvironmentId: null }
    actions.reveal('/remote/report.html', target)
    actions.openFileInSystemApp('/remote/report.html', target)
    expect(fixture.openFilePath).not.toHaveBeenCalled()
    expect(fixture.openInFileManager).not.toHaveBeenCalled()
  })
})
