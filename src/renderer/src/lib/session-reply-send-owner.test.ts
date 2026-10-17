import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { toRuntimeExecutionHostId } from '../../../shared/execution-host'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import type { SidebarSession } from './sidebar-sessions'
import type { WorktreeRuntimeOwnerState } from './worktree-runtime-owner-state'
import {
  LEAF_ID,
  OTHER_LEAF_ID,
  PASTE_BEGIN,
  PASTE_END
} from './active-agent-note-send-test-harness'

const mocks = vi.hoisted(() => ({
  state: {} as WorktreeRuntimeOwnerState,
  rpc: vi.fn(),
  structured: vi.fn()
}))

vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.state } }))
vi.mock('@/runtime/runtime-rpc-client', async () => ({
  ...(await vi.importActual('@/runtime/runtime-rpc-client')),
  callRuntimeRpc: mocks.rpc
}))
vi.mock('@/components/inbox/inbox-structured-instruction', () => ({
  sendInboxStructuredInstruction: mocks.structured
}))

import { sendSessionReply } from './session-reply-send'

const WORKTREE = 'repo::thread'
const OWNER = 'rental owner/1'
const OWNER_TARGET = { kind: 'environment', environmentId: OWNER } as const
const HOST_TAB = 'owner-tab%2Fraw'
const MIRRORED_TAB = toWebTerminalSurfaceTabId(HOST_TAB)
const HANDLE = 'owner-terminal'
const METHODS = [
  'terminal.list',
  'terminal.agentStatus',
  'terminal.send',
  'terminal.agentStatus',
  'terminal.send'
]

function stateForHost(hostId: ExecutionHostId): WorktreeRuntimeOwnerState {
  return {
    activeWorktreeId: 'another-worktree',
    activeWorkspaceExecutionHostId: 'runtime:focused-env',
    settings: { activeRuntimeEnvironmentId: 'focused-env' },
    repos: [{ id: 'repo', executionHostId: hostId, connectionId: null }],
    worktreesByRepo: { repo: [{ id: WORKTREE, repoId: 'repo', hostId }] },
    runtimeEnvironments: [{ id: 'focused-env' }, { id: OWNER }],
    runtimeEnvironmentCatalogHydrated: true
  }
}

function session(overrides: Partial<SidebarSession> = {}): SidebarSession {
  return {
    rowKey: 'paired-thread',
    sessionKey: null,
    worktreeId: WORKTREE,
    hostId: toRuntimeExecutionHostId(OWNER),
    tabId: MIRRORED_TAB,
    paneKey: makePaneKey(MIRRORED_TAB, LEAF_ID),
    kind: 'terminal',
    label: 'Rental work',
    workspaceLabel: 'Project',
    agent: 'claude',
    unavailable: false,
    folderKeyMigration: null,
    ...overrides
  }
}

function serveTerminal({
  tabId = HOST_TAB,
  leafId = LEAF_ID,
  failAt = -1
}: { tabId?: string; leafId?: string; failAt?: number } = {}): void {
  let callIndex = 0
  mocks.rpc.mockImplementation(async (_target, method, params) => {
    if (callIndex++ === failAt) {
      throw new Error('owner transport disconnected')
    }
    if (method === 'terminal.list') {
      return {
        terminals: [{ handle: HANDLE, worktreeId: WORKTREE, tabId, leafId }],
        totalCount: 1,
        truncated: false
      }
    }
    if (method === 'terminal.agentStatus') {
      return { agentStatus: { handle: HANDLE, isRunningAgent: true, status: 'idle' } }
    }
    if (method === 'terminal.send') {
      return { send: { accepted: true, bytesWritten: params.text?.length ?? 1 } }
    }
    throw new Error(`Unexpected RPC: ${method}`)
  })
}

function expectGuardedReply(target: RuntimeClientTarget): void {
  expect(mocks.rpc.mock.calls.map((call) => call[1])).toEqual(METHODS)
  expect(
    mocks.rpc.mock.calls.every((call) => JSON.stringify(call[0]) === JSON.stringify(target))
  ).toBe(true)
  expect(mocks.rpc).toHaveBeenNthCalledWith(
    1,
    target,
    'terminal.list',
    { worktree: `id:${WORKTREE}`, limit: 200, includeVisualLayouts: false },
    { timeoutMs: 15000 }
  )
  expect(mocks.rpc).toHaveBeenNthCalledWith(
    3,
    target,
    'terminal.send',
    {
      terminal: HANDLE,
      text: `${PASTE_BEGIN}Follow up${PASTE_END}`,
      requireAgentStatus: 'sendable',
      client: { id: 'omni-desktop', type: 'desktop' }
    },
    { timeoutMs: 15000 }
  )
  expect(mocks.rpc).toHaveBeenLastCalledWith(
    target,
    'terminal.send',
    {
      terminal: HANDLE,
      enter: true,
      requireAgentStatus: 'sendable',
      client: { id: 'omni-desktop', type: 'desktop' }
    },
    { timeoutMs: 15000 }
  )
  expect(mocks.structured).not.toHaveBeenCalled()
}

describe('session reply execution owner', () => {
  beforeEach(() => {
    mocks.state = stateForHost('local')
    mocks.rpc.mockReset()
    mocks.structured.mockReset()
  })

  it.each<ExecutionHostId>(['local', 'runtime:focused-env'])(
    'uses the paired row owner when the same workspace is focused on %s',
    async (focusedHost) => {
      mocks.state = {
        ...stateForHost(focusedHost),
        activeWorktreeId: WORKTREE,
        activeWorkspaceExecutionHostId: focusedHost
      }
      serveTerminal()

      await sendSessionReply(session(), 'Follow up')

      expectGuardedReply(OWNER_TARGET)
    }
  )

  it.each([
    { name: 'another leaf', tabId: HOST_TAB, leafId: OTHER_LEAF_ID },
    { name: 'another terminal', tabId: 'unrelated-owner-tab', leafId: LEAF_ID }
  ])('does not send to $name returned by the owner', async ({ tabId, leafId }) => {
    serveTerminal({ tabId, leafId })

    await expect(sendSessionReply(session(), 'Follow up')).rejects.toThrow()

    expect(mocks.rpc.mock.calls.map((call) => call[1])).toEqual(['terminal.list'])
    expect(mocks.rpc.mock.calls[0][0]).toEqual(OWNER_TARGET)
  })

  it.each([0, 1, 2, 3, 4])(
    'never retries or changes owners after transport failure at call %i',
    async (failAt) => {
      serveTerminal({ failAt })

      await expect(sendSessionReply(session(), 'Follow up')).rejects.toThrow(
        'owner transport disconnected'
      )

      expect(mocks.rpc.mock.calls.map((call) => call[1])).toEqual(METHODS.slice(0, failAt + 1))
      expect(
        mocks.rpc.mock.calls.every(
          (call) => JSON.stringify(call[0]) === JSON.stringify(OWNER_TARGET)
        )
      ).toBe(true)
    }
  )

  it.each<ExecutionHostId>(['local', 'ssh:rental-ssh'])(
    'preserves the existing %s worktree route and raw terminal identity',
    async (hostId) => {
      mocks.state = stateForHost(hostId)
      const rawTabId = 'web-terminal-local%2Fraw'
      serveTerminal({ tabId: rawTabId })

      await sendSessionReply(
        session({
          hostId,
          tabId: rawTabId,
          paneKey: makePaneKey(rawTabId, LEAF_ID)
        }),
        'Follow up'
      )

      // Direct SSH terminals are controlled through the local runtime's owning relay.
      expectGuardedReply({ kind: 'local' })
    }
  )

  it('rejects a row whose pane belongs to another tab before contacting any runtime', async () => {
    await expect(
      sendSessionReply(
        session({
          paneKey: makePaneKey(toWebTerminalSurfaceTabId('different-tab'), LEAF_ID)
        }),
        'Follow up'
      )
    ).rejects.toThrow('This thread’s terminal is no longer available.')

    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it.each<SidebarSession['hostId']>([null, 'runtime:'])(
    'refuses missing or invalid execution host %s without falling back locally',
    async (hostId) => {
      await expect(sendSessionReply(session({ hostId }), 'Follow up')).rejects.toThrow(
        'This thread’s terminal is no longer available.'
      )

      expect(mocks.rpc).not.toHaveBeenCalled()
    }
  )
})
