import { beforeEach, expect, it, vi } from 'vitest'
import type { SessionPrepConnectorLaunch } from '../../shared/session-prep-connector'
import type { SessionPrepBatchRecord, SessionPrepItemRecord } from './session-prep-records'
import type { SessionPrepLaunchContext } from './session-prep-launch'
import { createSessionPrepRuntimeHost, type SessionPrepRuntime } from './session-prep-runtime-host'
import {
  launchSessionPrepWorktree,
  launchSessionPrepSession
} from './session-prep-launch-executors'
import { sessionPrepConnectorPrompt } from './session-prep-connector-launch'

const { readTools } = vi.hoisted(() => ({ readTools: vi.fn() }))
vi.mock('../runtime/managed-session-tools-files', () => ({
  readManagedSessionToolsFiles: readTools
}))
const launch: SessionPrepConnectorLaunch = {
  managedToolsFile: '/private/descriptor.json',
  nativeOperationId: '1791410000000-0123456789abcdef0123456789abcdef',
  resultsFolder: '/private/results',
  title: 'Fix parser'
}

beforeEach(() => readTools.mockReset().mockReturnValue({ assertCurrent: vi.fn() }))
function fixture() {
  const repo = { id: 'repo', path: '/src', displayName: 'App' }
  const runtime = {
    getStatus: () => ({ runtimeId: 'runtime-local' }),
    listRepos: () => [repo],
    listFolderWorkspaces: () => [],
    listManagedWorktrees: vi.fn(),
    requestSessionFolders: vi.fn(),
    createManagedWorktree: vi.fn(async () => ({ worktree: { id: 'repo::/new-worktree' } })),
    createAgentSession: vi.fn(async () => ({
      disposition: 'created',
      terminal: { handle: 'term_real', paneKey: 'tab:pane', tabId: 'tab' },
      launch: { model: 'gpt-5.4-mini', effort: 'low' }
    }))
  } as unknown as SessionPrepRuntime
  const host = createSessionPrepRuntimeHost(runtime, () => [])
  const item = {
    index: 0,
    state: 'ready',
    planned: { title: 'Fix parser', changesCode: true },
    verdicts: [],
    repairs: 0
  } as unknown as SessionPrepItemRecord
  const batch = { id: 'batch', connectorLaunch: launch, items: [item] } as SessionPrepBatchRecord
  const ctx = {
    host,
    persist: vi.fn(),
    now: () => 1,
    isCancelled: () => false
  } as unknown as SessionPrepLaunchContext
  return { runtime, item, batch, ctx }
}
it.each(['worktree', 'session'])(
  'keeps managed tool authority and actual native receipt on a connector %s launch',
  async (kind) => {
    const { runtime, item, batch, ctx } = fixture()
    const choice = {
      agent: 'codex' as const,
      model: 'gpt-5.4-mini',
      effort: 'low' as const,
      notes: []
    }
    const prompt = sessionPrepConnectorPrompt('Fix parser retries.', launch)
    if (kind === 'worktree') {
      await launchSessionPrepWorktree(ctx, batch, item, 'repo', choice, prompt, 1)
      const worktreeArgs = vi.mocked(runtime.createManagedWorktree).mock.calls[0]![0]
      expect(worktreeArgs).not.toHaveProperty('startupAgent')
      expect(worktreeArgs).not.toHaveProperty('startupPrompt')
    } else {
      await launchSessionPrepSession(ctx, batch, item, 'repo::/src', choice, prompt, 1)
    }
    expect(runtime.createAgentSession).toHaveBeenCalledOnce()
    expect(vi.mocked(runtime.createAgentSession).mock.calls[0]![0]).toMatchObject({
      clientOperationId: launch.nativeOperationId,
      managedToolsFile: launch.managedToolsFile,
      agent: 'codex',
      prompt,
      launchPreferences: { model: 'gpt-5.4-mini', effort: 'low' }
    })
    expect(readTools).toHaveBeenCalledWith(launch.managedToolsFile, {
      nativeOperationId: launch.nativeOperationId,
      provider: 'codex'
    })
    expect(item.launched?.nativeReceipt).toMatchObject({
      operationId: launch.nativeOperationId,
      provider: 'codex',
      terminal: { handle: 'term_real', paneKey: 'tab:pane' },
      disposition: 'created'
    })
  }
)
it('keeps the person’s words at the top and adds the results-folder instruction once', () => {
  const words = 'Please fix\nparser retries exactly as discussed.'
  const prompt = sessionPrepConnectorPrompt(words, launch)
  expect(prompt.startsWith(words)).toBe(true)
  expect(prompt).toContain(
    `Save finished deliverable files in this session's results folder: ${launch.resultsFolder}.`
  )
  expect(sessionPrepConnectorPrompt(prompt, launch)).toBe(prompt)
  expect(sessionPrepConnectorPrompt(words)).toBe(words)
})
