import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SESSION_PREP_RPC } from '../../../../shared/session-prep-types'
import {
  armSessionPrepUndoBypass,
  resetSessionPrepComposerStateForTests
} from './session-prep-composer-state'

const mocks = vi.hoisted(() => ({
  callRuntimeRpc: vi.fn(),
  upNextAddressForPane: vi.fn(),
  sessionPrepProjectFolderForPane: vi.fn()
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: (...args: unknown[]) => mocks.callRuntimeRpc(...args)
}))
vi.mock('@/lib/conversation-source-for-pane', () => ({
  upNextAddressForPane: (...args: unknown[]) => mocks.upNextAddressForPane(...args)
}))
vi.mock('@/lib/session-prep-project-folder', () => ({
  sessionPrepProjectFolderForPane: (...args: unknown[]) =>
    mocks.sessionPrepProjectFolderForPane(...args)
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, options?: Record<string, string>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_, name: string) => options?.[name] ?? '')
}))

import { useSessionPrepCommand } from './use-session-prep-command'

const localAddress = {
  source: { worktreeId: 'wt-1', paneKey: 'pane-1', kind: 'pty' as const },
  owner: { kind: 'local' as const }
}

function useCommand() {
  const setDraft = vi.fn()
  const report = vi.fn()
  const getContext = vi.fn(() => 'User: earlier')
  const prepare = useSessionPrepCommand({
    paneKey: 'pane-1',
    tabId: 'tab-1',
    agent: 'claude',
    getContext,
    setDraft,
    report
  })
  return { prepare, setDraft, report, getContext }
}

describe('useSessionPrepCommand', () => {
  beforeEach(() => {
    resetSessionPrepComposerStateForTests()
    mocks.callRuntimeRpc.mockReset()
    mocks.upNextAddressForPane.mockReset()
    mocks.callRuntimeRpc.mockResolvedValue({ id: 'batch-1' })
    mocks.upNextAddressForPane.mockReturnValue(localAddress)
    mocks.sessionPrepProjectFolderForPane.mockReset()
    mocks.sessionPrepProjectFolderForPane.mockReturnValue(null)
  })

  afterEach(() => {
    resetSessionPrepComposerStateForTests()
  })

  it('returns false when the text is not a session-prep ask', () => {
    const { prepare, setDraft } = useCommand()
    expect(prepare('fix the fair-use page')).toBe(false)
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
    expect(setDraft).not.toHaveBeenCalled()
  })

  it('requests prep for a detected ask on a local conversation', async () => {
    const { prepare, setDraft, getContext } = useCommand()
    const text = 'create sessions for the fair-use fix and the badge'
    expect(prepare(text)).toBe(true)
    expect(setDraft).toHaveBeenCalledWith('')
    expect(mocks.upNextAddressForPane).toHaveBeenCalledWith('pane-1', 'tab-1')
    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith({ kind: 'local' }, SESSION_PREP_RPC.request, {
      text,
      source: { worktreeId: 'wt-1', paneKey: 'pane-1', agent: 'claude' },
      context: 'User: earlier'
    })
    expect(getContext).toHaveBeenCalledOnce()
    await Promise.resolve()
  })

  it('files the prepared sessions in the project the conversation lives in', async () => {
    mocks.sessionPrepProjectFolderForPane.mockReturnValue('folder-project')
    const { prepare } = useCommand()
    const text = 'create sessions for the fair-use fix and the badge'
    expect(prepare(text)).toBe(true)
    expect(mocks.sessionPrepProjectFolderForPane).toHaveBeenCalledWith('pane-1', 'tab-1')
    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith({ kind: 'local' }, SESSION_PREP_RPC.request, {
      text,
      source: { worktreeId: 'wt-1', paneKey: 'pane-1', agent: 'claude' },
      context: 'User: earlier',
      defaultFolder: 'folder-project'
    })
    await Promise.resolve()
  })

  it('does not intercept when the pane has no local owner', () => {
    mocks.upNextAddressForPane.mockReturnValue(null)
    const { prepare, setDraft } = useCommand()
    expect(prepare('create sessions for one and two')).toBe(false)
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
    expect(setDraft).not.toHaveBeenCalled()
  })

  it('does not intercept remote-owned conversations', () => {
    mocks.upNextAddressForPane.mockReturnValue({
      ...localAddress,
      owner: { kind: 'environment', environmentId: 'env-1' }
    })
    const { prepare, setDraft } = useCommand()
    expect(prepare('create sessions for one and two')).toBe(false)
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
    expect(setDraft).not.toHaveBeenCalled()
  })

  it('restores the draft and reports when the request fails', async () => {
    mocks.callRuntimeRpc.mockRejectedValue(new Error('host unavailable'))
    const { prepare, setDraft, report } = useCommand()
    const text = 'create sessions for one and two'
    expect(prepare(text)).toBe(true)
    expect(setDraft).toHaveBeenCalledWith('')
    await Promise.resolve()
    await Promise.resolve()
    expect(setDraft).toHaveBeenCalledWith(text)
    expect(report).toHaveBeenCalledWith('Could not start preparing sessions: host unavailable')
  })

  it('lets the restored Undo text through to the agent once', () => {
    const text = 'create sessions for one and two'
    armSessionPrepUndoBypass('pane-1', text)
    const { prepare } = useCommand()
    expect(prepare(text)).toBe(false)
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
    expect(prepare(text)).toBe(true)
    expect(mocks.callRuntimeRpc).toHaveBeenCalledOnce()
  })
})
