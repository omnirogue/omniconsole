// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { buildSidebarSessions } from '@/lib/sidebar-sessions'
import {
  sessionTestSource,
  addSessionTestTab,
  addSessionTestRecord,
  SESSION_TEST_LEAF
} from '@/lib/sidebar-session-test-fixtures'
import { selectConsoleAccountScope } from '@/lib/console-account-scope'
import { rememberAttachedTaskContext } from '@/lib/session-task-context'
import { linkSessionToTask, useSessionTasks } from '@/store/session-task-store'
import { sidebarSessionSourceIdentity } from '@/lib/sidebar-session-source-identity'
import { useNativeChatPtyComposerSend } from './use-native-chat-pty-composer-send'
import { resetNativeChatPtySendQueuesForTests } from './native-chat-pty-send-queue'

const writes = vi.hoisted(() => vi.fn())
const contextRead = vi.hoisted(() => vi.fn())
vi.mock('@/lib/console-workflow-client', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  consoleWorkflowApi: () => ({ sessionTaskContext: contextRead })
}))
vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  sendRuntimePtyInput: writes,
  sendRuntimePtyInputVerified: vi.fn(),
  isRemoteRuntimePtyId: (id: string) => id.startsWith('remote:')
}))
vi.mock('@/lib/native-chat-telemetry', () => ({ emitNativeChatMessageSent: vi.fn() }))

const memory = 'Original parent scope.\nHuman decision: retain all acceptance criteria.\n'
const writtenText = () =>
  writes.mock.calls
    .map((call) => call[2])
    .join('')
    .replaceAll('\r', '\n')

function fixture() {
  const source = sessionTestSource()
  const tab = addSessionTestTab(source)
  addSessionTestRecord(source, tab)
  source.terminalLayoutsByTabId[tab.id]!.ptyIdsByLeafId = { [SESSION_TEST_LEAF]: 'pty-1' }
  useAppStore.setState({ ...source, activeOrcaProfileId: 'person-a' })
  const row = buildSidebarSessions(useAppStore.getState())[0]!
  linkSessionToTask(sidebarSessionSourceIdentity(row)!.sourceKey, {
    taskId: 'btk_parent001',
    sessionId: 'ses_source001'
  })
  expect(
    rememberAttachedTaskContext(
      row,
      {
        ok: true,
        taskId: 'btk_parent001',
        sessionId: 'ses_source001',
        context: {
          card_id: 'btk_parent001',
          state_revision: 3,
          available: true,
          status: 'ready',
          context: memory,
          warnings: [],
          scope: null,
          pack_version: 2,
          replies_waiting: [],
          dropped_blocks: []
        }
      },
      selectConsoleAccountScope(useAppStore.getState())
    )
  ).toBe(true)
  const args: Parameters<typeof useNativeChatPtyComposerSend>[0] = {
    agent: 'codex',
    draft: 'Continue the work',
    imageAttachments: [],
    disabled: false,
    isDispatchingSessionOption: false,
    launchDraftResolved: true,
    resolveTarget: () => ({ ptyId: 'pty-1', settings: null }),
    classifySend: (text) => (text.startsWith('/') ? 'command' : 'chat'),
    sessionOptionsSurface: null,
    terminalTabId: tab.id,
    trackPendingSend: vi.fn(),
    setHistory: vi.fn(),
    setDraft: vi.fn(),
    setCaret: vi.fn(),
    clearSkillOrigin: vi.fn(),
    clearImageAttachments: vi.fn(),
    setNotice: vi.fn()
  }
  return { args, source, tab }
}

beforeEach(() => {
  vi.useFakeTimers()
  writes.mockClear()
  localStorage.clear()
  useSessionTasks.setState({ links: {}, loaded: true })
  contextRead.mockReset().mockResolvedValue({
    ok: true,
    data: {
      ok: true,
      taskId: 'btk_parent001',
      sessionId: 'ses_source001',
      context: {
        card_id: 'btk_parent001',
        state_revision: 3,
        available: true,
        status: 'ready',
        context: memory,
        warnings: [],
        scope: null,
        pack_version: 2,
        replies_waiting: [],
        dropped_blocks: []
      }
    }
  })
})
afterEach(() => {
  resetNativeChatPtySendQueuesForTests()
  vi.useRealTimers()
})

describe('parent memory in controlled PTY chat sends', () => {
  it('submits long OMP messages with task context as one paste event in the direct transport', async () => {
    const { args } = fixture()
    args.agent = 'omp'
    args.draft = Array.from(
      { length: 150 },
      (_, index) => `Evidence ${index}: ${'x'.repeat(120)}`
    ).join('\n')
    const { result } = renderHook(() => useNativeChatPtyComposerSend(args))

    await act(async () => {
      expect(result.current()).toBe(true)
    })
    expect(writes.mock.calls.some((call) => String(call[2]).includes('\x1b[200~'))).toBe(false)

    await act(async () => {
      await vi.runAllTimersAsync()
    })

    const pastes = writes.mock.calls.filter((call) => String(call[2]).startsWith('\x1b[200~'))
    expect(pastes).toHaveLength(1)
    const submitted = String(pastes[0]![2])
    expect(submitted.endsWith('\x1b[201~\r')).toBe(true)
    expect(submitted.replaceAll('\r', '\n')).toContain(args.draft)
    expect(submitted.replaceAll('\r', '\n')).toContain(memory)
    expect(writes.mock.calls.some((call) => call[2] === '\r')).toBe(false)
  })

  it.each([
    'can you make a handoff for uma as what he needs to integrate to his branch',
    'fix the bug where we close the session twice',
    'When done, add a Codex reviewer and mark this complete.'
  ])(
    'sends a request that mentions next steps without injected instructions: %s',
    async (prompt) => {
      const { args } = fixture()
      args.onOptimisticSend = vi.fn()
      const { result } = renderHook(() => useNativeChatPtyComposerSend(args))
      await act(async () => {
        expect(result.current(prompt)).toBe(true)
      })
      const submitted = writtenText()
      expect(submitted).toContain(prompt)
      expect(submitted).toContain(memory)
      expect(submitted).not.toContain('outcome context')
      expect(submitted).not.toContain('omni-outcome-source-v1')
      expect(submitted).not.toContain('Next-step request')
      expect(args.onOptimisticSend).toHaveBeenCalledWith(prompt, [])
    }
  )

  it('writes the saved context in the ordinary message and consumes it only after submission', async () => {
    const { args } = fixture()
    const { result } = renderHook(() => useNativeChatPtyComposerSend(args))
    expect(writes).not.toHaveBeenCalled()
    await act(async () => {
      expect(result.current()).toBe(true)
    })
    expect(writtenText()).toContain(memory)
    await act(async () => {
      await vi.runAllTimersAsync()
    })
    writes.mockClear()
    await act(async () => {
      result.current('Continue again')
    })
    expect(writtenText()).not.toContain(memory)
  })

  it('keeps memory pending when the send is cancelled before Enter', async () => {
    const { args } = fixture()
    const { result } = renderHook(() => useNativeChatPtyComposerSend(args))
    await act(async () => {
      result.current()
    })
    const handle = vi.mocked(args.trackPendingSend).mock.calls[0]![0]
    act(() => {
      handle.cancel()
    })
    await act(async () => {
      await vi.runAllTimersAsync()
    })
    writes.mockClear()
    await act(async () => {
      result.current('Try again')
    })
    expect(writtenText()).toContain(memory)
  })

  it('does not inject into slash commands or a reused pane with another provider session', async () => {
    const { args, source, tab } = fixture()
    const { result } = renderHook(() => useNativeChatPtyComposerSend(args))
    act(() => {
      result.current('/model')
    })
    await act(async () => {
      await vi.runAllTimersAsync()
    })
    expect(writtenText()).not.toContain(memory)
    addSessionTestRecord(source, tab, 'replacement-provider')
    useAppStore.setState(source)
    writes.mockClear()
    act(() => {
      result.current('Continue another conversation')
    })
    expect(writtenText()).not.toContain(memory)
  })

  it('refreshes a newly uploaded file before the next ordinary send at the same task revision', async () => {
    const { args } = fixture()
    const { result } = renderHook(() => useNativeChatPtyComposerSend(args))
    await act(async () => {
      result.current()
      await vi.runAllTimersAsync()
    })
    writes.mockClear()
    const response = await contextRead()
    contextRead.mockResolvedValue({
      ...response,
      data: {
        ...response.data,
        context: {
          ...response.data.context,
          pack_version: 3,
          context: 'NEW-UPLOAD uploads/brief.pdf'
        }
      }
    })
    await act(async () => {
      result.current('Use the new upload')
    })
    expect(writtenText()).toContain('NEW-UPLOAD uploads/brief.pdf')
    expect(writtenText()).not.toContain(memory)
  })

  it.each(['unbind', 'account', 'host'] as const)(
    'holds the draft without writing after %s during refresh',
    async (change) => {
      const { args } = fixture()
      let complete!: (value: unknown) => void
      const response = await contextRead()
      contextRead.mockReturnValueOnce(
        new Promise((resolve) => {
          complete = resolve
        })
      )
      const { result, rerender } = renderHook((current) => useNativeChatPtyComposerSend(current), {
        initialProps: args
      })
      act(() => {
        result.current()
      })
      expect(writes).not.toHaveBeenCalled()
      if (change === 'unbind') {
        const key = sidebarSessionSourceIdentity(
          buildSidebarSessions(useAppStore.getState())[0]!
        )!.sourceKey
        linkSessionToTask(key, null)
      } else if (change === 'account') {
        useAppStore.setState({ activeOrcaProfileId: 'person-b' })
      } else {
        rerender({
          ...args,
          resolveTarget: () => ({
            ptyId: 'pty-other',
            settings: { activeRuntimeEnvironmentId: 'other-host' }
          })
        })
      }
      await act(async () => {
        complete(response)
      })
      expect(writes).not.toHaveBeenCalled()
      expect(args.setDraft).not.toHaveBeenCalled()
      expect(args.setNotice).toHaveBeenCalledWith(expect.any(String))
    }
  )

  it('keeps the draft on refresh failure and cancels a queued context send after unbind', async () => {
    const { args } = fixture()
    contextRead.mockRejectedValueOnce(new Error('Context unavailable'))
    const { result } = renderHook(() => useNativeChatPtyComposerSend(args))
    await act(async () => {
      result.current()
    })
    expect(writes).not.toHaveBeenCalled()
    expect(args.setDraft).not.toHaveBeenCalled()
    await act(async () => {
      result.current()
    })
    const key = sidebarSessionSourceIdentity(
      buildSidebarSessions(useAppStore.getState())[0]!
    )!.sourceKey
    linkSessionToTask(key, null)
    writes.mockClear()
    await act(async () => {
      await vi.runAllTimersAsync()
    })
    expect(writes.mock.calls.some((call) => call[2] === '\r')).toBe(false)
  })
})
