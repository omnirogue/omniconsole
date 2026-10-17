// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../../store'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import {
  clearNativeChatSessionOptionCacheForTests,
  readNativeChatSessionOptionCache,
  seedNativeChatAppliedSessionOptions,
  writeNativeChatSessionOptionCache
} from './native-chat-session-option-cache'
import type { NativeChatPtySessionOptionsSurface } from './native-chat-pty-session-options'
import {
  disposeCodexResumeRelaunchCapture,
  readCodexResumeRelaunch,
  resetCodexResumeRelaunchForTests
} from './codex-resume-relaunch-state'

const mocks = vi.hoisted(() => {
  const liveWatchers = new Map<string, Set<(data: string) => void>>()
  return {
    cancelNativeChatPtySends: vi.fn(),
    waitForNativeChatPtyIdle: vi.fn(async (_ptyId: string) => undefined),
    toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
    liveWatchers,
    subscribeToPtyData: (ptyId: string, watcher: (data: string) => void): (() => void) => {
      const set = liveWatchers.get(ptyId) ?? new Set<(data: string) => void>()
      set.add(watcher)
      liveWatchers.set(ptyId, set)
      return () => {
        set.delete(watcher)
      }
    }
  }
})

vi.mock('sonner', () => ({ toast: mocks.toast }))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string | number>) =>
    values
      ? Object.entries(values).reduce(
          (text, [name, value]) => text.replaceAll(`{{${name}}}`, String(value)),
          fallback
        )
      : fallback
}))
vi.mock('../terminal-pane/pty-data-sidecar-subscriptions', () => ({
  subscribeToPtyData: mocks.subscribeToPtyData
}))
vi.mock('./native-chat-pty-send-queue', () => ({
  cancelNativeChatPtySends: (ptyId: string) => mocks.cancelNativeChatPtySends(ptyId),
  waitForNativeChatPtyIdle: (ptyId: string) => mocks.waitForNativeChatPtyIdle(ptyId)
}))

import { useCodexResumeRelaunch } from './use-codex-resume-relaunch'

const PANE = 'tab-1:leaf-1'
const OLD_PTY = 'wt1@@pty-1'
const NEW_PTY = 'wt1@@pty-2'
const THREAD = { key: 'session_id' as const, id: 'thread-1' }

function entry(overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  return {
    state: 'done',
    prompt: 'hi',
    updatedAt: Date.now() - 1000,
    stateStartedAt: Date.now() - 1000,
    paneKey: PANE,
    agentType: 'codex',
    stateHistory: [],
    providerSession: THREAD,
    ...overrides
  }
}

function seedStore(): void {
  useAppStore.setState({
    settings: {} as never,
    worktreesByRepo: { repo1: [{ id: 'wt1', path: '/Users/dev/code/omni' }] } as never,
    tabsByWorktree: {
      wt1: [
        {
          id: 'tab-1',
          ptyId: OLD_PTY,
          worktreeId: 'wt1',
          title: 'codex',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1,
          launchAgent: 'codex' as const
        }
      ]
    } as never,
    ptyIdsByTabId: { 'tab-1': [OLD_PTY] },
    agentStatusByPaneKey: { [PANE]: entry() }
  })
}

function makeSurface() {
  const surface = {
    getSnapshot: () => [],
    setOption: vi.fn(),
    invokeAction: vi.fn(),
    subscribe: () => () => {},
    recordOutgoingCommand: vi.fn(),
    replaceModels: vi.fn(),
    confirmRelaunchedSessionOptions:
      vi.fn<NativeChatPtySessionOptionsSurface['confirmRelaunchedSessionOptions']>(),
    reportSessionOptions: vi.fn<NativeChatPtySessionOptionsSurface['reportSessionOptions']>(),
    dropDispatchedSessionOptions:
      vi.fn<NativeChatPtySessionOptionsSurface['dropDispatchedSessionOptions']>()
  }
  return surface as typeof surface & NativeChatPtySessionOptionsSurface
}

type Props = { targetPtyId: string | null; isWorking?: boolean }

/** Bytes the replacement pty emits; the only evidence the verifier reads. */
function feedLive(ptyId: string, chunk: string): void {
  for (const watcher of Array.from(mocks.liveWatchers.get(ptyId) ?? [])) {
    watcher(chunk)
  }
}

const liveWatcherCount = (ptyId: string): number => mocks.liveWatchers.get(ptyId)?.size ?? 0

function setup(screen: { current: string | null } = { current: 'gpt-5.5 medium · ~/repo' }) {
  const surface = makeSurface()
  const rendered = renderHook(
    ({ targetPtyId, isWorking = false }: Props) =>
      useCodexResumeRelaunch({
        agent: 'codex',
        paneKey: PANE,
        terminalTabId: 'tab-1',
        targetPtyId,
        isWorking,
        surface,
        readTerminalScreen: () => screen.current
      }),
    { initialProps: { targetPtyId: OLD_PTY } as Props }
  )
  return { ...rendered, surface, screen }
}

async function relaunch(
  result: ReturnType<typeof setup>['result'],
  onCommitted = vi.fn()
): Promise<ReturnType<typeof vi.fn>> {
  await act(async () => {
    await result.current.relaunchSessionOptions!({
      requested: { model: 'gpt-5.5', effort: 'high' },
      selectedOption: 'effort',
      onCommitted
    })
  })
  return onCommitted
}

async function tick(ms = 300): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms)
  })
}

describe('useCodexResumeRelaunch', () => {
  beforeEach(() => {
    mocks.liveWatchers.clear()
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    vi.clearAllMocks()
    mocks.waitForNativeChatPtyIdle.mockImplementation(async (_ptyId: string) => undefined)
    useAppStore.setState(useAppStore.getInitialState(), true)
    resetCodexResumeRelaunchForTests()
    clearNativeChatSessionOptionCacheForTests()
    seedStore()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('drains sends, re-checks, commits, mirrors and queues the startup on the live pty', async () => {
    seedNativeChatAppliedSessionOptions(OLD_PTY, 'codex', { model: 'gpt-5.5', effort: 'medium' })
    const { result } = setup()
    const onCommitted = vi.fn(() => {
      // Order: the drain ran first, the restart is not queued yet.
      expect(mocks.cancelNativeChatPtySends).toHaveBeenCalledWith(OLD_PTY)
      expect(mocks.waitForNativeChatPtyIdle).toHaveBeenCalledWith(OLD_PTY)
      expect(useAppStore.getState().pendingCodexPaneRestartIds[OLD_PTY]).toBeUndefined()
      writeNativeChatSessionOptionCache(OLD_PTY, {
        agent: 'codex',
        model: { value: 'gpt-5.5', source: 'dispatched' },
        valuesByModel: { 'gpt-5.5': { effort: { value: 'high', source: 'dispatched' } } }
      })
    })

    await relaunch(result, onCommitted)

    expect(onCommitted).toHaveBeenCalledOnce()
    const state = useAppStore.getState()
    expect(state.pendingCodexPaneRestartIds).toEqual({ [OLD_PTY]: true })
    expect(state.pendingCodexPaneRestartStartupByPtyId[OLD_PTY]?.command).toContain(
      "'resume' 'thread-1'"
    )
    expect(state.pendingCodexPaneRestartStartupByPtyId[OLD_PTY]).toMatchObject({
      launchAgent: 'codex',
      resumeProviderSession: THREAD
    })
    // The tab-scope mirror carries the dispatched values for the surface rebuilt on the new id.
    expect(readNativeChatSessionOptionCache('tab-1')?.valuesByModel['gpt-5.5']?.effort).toEqual({
      value: 'high',
      source: 'dispatched'
    })
    expect(result.current.status).toMatchObject({
      phase: 'restarting',
      previousPtyId: OLD_PTY,
      threadId: 'thread-1'
    })
  })

  it('re-checks working after the drain', async () => {
    const { result } = setup()
    mocks.waitForNativeChatPtyIdle.mockImplementation(async () => {
      useAppStore.setState({
        agentStatusByPaneKey: { [PANE]: entry({ state: 'working', updatedAt: Date.now() }) }
      })
    })
    const onCommitted = vi.fn()
    await expect(
      result.current.relaunchSessionOptions!({
        requested: { model: 'gpt-5.5' },
        selectedOption: 'model',
        onCommitted
      })
    ).rejects.toThrow('Codex is still working')
    expect(onCommitted).not.toHaveBeenCalled()
    expect(useAppStore.getState().pendingCodexPaneRestartIds).toEqual({})
    expect(readCodexResumeRelaunch(PANE)).toBeNull()
  })

  it('refuses a second apply while in flight', async () => {
    const { result } = setup()
    await relaunch(result)
    await expect(
      result.current.relaunchSessionOptions!({
        requested: { model: 'gpt-5.5' },
        selectedOption: 'model',
        onCommitted: vi.fn()
      })
    ).rejects.toThrow('A restart is already in progress')
  })

  it('moves to verifying when targetPtyId changes', async () => {
    const { result, rerender } = setup()
    await relaunch(result)
    rerender({ targetPtyId: null })
    expect(result.current.status?.phase).toBe('restarting')
    rerender({ targetPtyId: NEW_PTY })
    expect(result.current.status).toMatchObject({ phase: 'verifying', newPtyId: NEW_PTY })
  })

  it('confirms when the header matches', async () => {
    const { result, rerender, surface } = setup()
    await relaunch(result)
    rerender({ targetPtyId: NEW_PTY })
    feedLive(NEW_PTY, 'gpt-5.5 high · ~/repo\n')
    await tick()
    expect(surface.confirmRelaunchedSessionOptions).toHaveBeenCalledExactlyOnceWith({
      observed: { model: 'gpt-5.5', effort: 'high' },
      requested: { model: 'gpt-5.5', effort: 'high' },
      selectedOption: 'effort'
    })
    expect(result.current.status).toMatchObject({
      phase: 'confirmed',
      observed: { model: 'gpt-5.5', effort: 'high' }
    })
    expect(mocks.toast.success).toHaveBeenCalledWith('Codex is now on GPT-5.5 · High.')
  })

  it('refuses a second change while a fresh working row exists after the resume', async () => {
    const { result, rerender } = setup()
    await relaunch(result)
    rerender({ targetPtyId: NEW_PTY })
    feedLive(NEW_PTY, 'gpt-5.5 high · ~/repo\n')
    await tick()
    expect(result.current.status).toMatchObject({ phase: 'confirmed' })
    // Codex sends no SessionStart on resume: a working row now is a real turn.
    const bornAt = Date.now() + 100
    vi.setSystemTime(bornAt)
    useAppStore.setState({
      agentStatusByPaneKey: {
        [PANE]: entry({ state: 'working', updatedAt: bornAt, stateStartedAt: bornAt })
      }
    })
    await expect(
      act(async () => {
        await result.current.relaunchSessionOptions!({
          requested: { model: 'gpt-5.5', effort: 'xhigh' },
          selectedOption: 'effort',
          onCommitted: vi.fn()
        })
      })
    ).rejects.toThrow('Codex is still working')
    expect(result.current.status?.phase).toBe('confirmed')
  })

  it('reports mismatch when the header differs', async () => {
    const { result, rerender, surface } = setup()
    await relaunch(result)
    rerender({ targetPtyId: NEW_PTY })
    feedLive(NEW_PTY, 'gpt-5.5 low · ~/repo\n')
    await tick()
    expect(surface.reportSessionOptions).toHaveBeenCalledExactlyOnceWith({
      model: 'gpt-5.5',
      effort: 'low'
    })
    expect(surface.confirmRelaunchedSessionOptions).not.toHaveBeenCalled()
    expect(result.current.status?.phase).toBe('mismatch')
    expect(mocks.toast.warning).toHaveBeenCalledWith(
      'Codex came back with GPT-5.5 · Low, not GPT-5.5 · High. Showing what Codex reported.'
    )
  })

  it("reads the resumed process's startup box from its live bytes, ignoring transcript text that quotes an old footer", async () => {
    const { result, rerender, surface } = setup({ current: null })
    await relaunch(result)
    rerender({ targetPtyId: NEW_PTY })
    expect(liveWatcherCount(NEW_PTY)).toBe(1)
    feedLive(NEW_PTY, "% codex '-c' 'model_reasoning_effort=high' 'resume' 'thread-1'\n")
    await tick()
    expect(result.current.status?.phase).toBe('verifying')
    feedLive(
      NEW_PTY,
      `${[
        '╭──────────╮',
        '│ >_ OpenAI Codex (v0.154.0) │',
        '│ model: loading /model to change │'
      ].join('\n')}\n`
    )
    await tick()
    expect(result.current.status?.phase).toBe('verifying')
    feedLive(
      NEW_PTY,
      `${[
        '│ model: gpt-5.5 high /model to change │',
        '╰──────────╯',
        '› please resume thread-1 later and keep gpt-5.5 low · ~/repo in mind',
        'gpt-5.5 low · ~/repo'
      ].join('\n')}\n`
    )
    await tick()
    expect(result.current.status).toMatchObject({
      phase: 'confirmed',
      observed: { model: 'gpt-5.5', effort: 'high' }
    })
    expect(surface.reportSessionOptions).not.toHaveBeenCalled()
    // Verification over: the sidecar is released.
    expect(liveWatcherCount(NEW_PTY)).toBe(0)
  })

  it('never reads the shared buffers: a frozen xterm frame and pre-flip bytes prove nothing', async () => {
    const { result, rerender, surface, screen } = setup({ current: 'gpt-5.5 high · ~/repo' })
    await relaunch(result)
    // Bytes on the OLD pty (its death throes) are not the new process's.
    feedLive(OLD_PTY, 'gpt-5.5 high · ~/repo\n')
    rerender({ targetPtyId: NEW_PTY })
    screen.current = 'gpt-5.5 high · ~/repo'
    await tick(1500)
    expect(result.current.status?.phase).toBe('verifying')
    expect(surface.confirmRelaunchedSessionOptions).not.toHaveBeenCalled()
  })

  it('keeps the captured startup box across a remount mid-verification', async () => {
    const first = setup({ current: null })
    await relaunch(first.result)
    first.rerender({ targetPtyId: NEW_PTY })
    feedLive(
      NEW_PTY,
      `${['│ >_ OpenAI Codex (v0.154.0) │', '│ model: gpt-5.5 high /model to change │'].join('\n')}\n`
    )
    // The composer unmounts before the 300 ms tick (a view switch, a tab move).
    first.unmount()
    expect(liveWatcherCount(NEW_PTY)).toBe(1)
    // While unmounted the resumed transcript replays text quoting an old footer.
    feedLive(NEW_PTY, '› earlier we were on gpt-5.5 low · ~/repo\n')
    const second = setup({ current: null })
    second.rerender({ targetPtyId: NEW_PTY })
    await tick()
    expect(second.result.current.status).toMatchObject({
      phase: 'confirmed',
      observed: { model: 'gpt-5.5', effort: 'high' }
    })
    expect(second.surface.reportSessionOptions).not.toHaveBeenCalled()
    expect(liveWatcherCount(NEW_PTY)).toBe(0)
  })

  it('settles unverified when a verifying record has no capture continuity', async () => {
    const first = setup({ current: null })
    await relaunch(first.result)
    first.rerender({ targetPtyId: NEW_PTY })
    first.unmount()
    // Module state lost its capture (simulated): the bytes from the pty's first
    // moments are gone, so nothing read from here on may confirm or mismatch.
    disposeCodexResumeRelaunchCapture(PANE)
    const second = setup({ current: null })
    second.rerender({ targetPtyId: NEW_PTY })
    feedLive(NEW_PTY, 'gpt-5.5 high · ~/repo\n')
    await tick()
    expect(second.result.current.status?.phase).toBe('unverified')
    expect(second.surface.confirmRelaunchedSessionOptions).not.toHaveBeenCalled()
    expect(second.surface.dropDispatchedSessionOptions).toHaveBeenCalledOnce()
  })

  it('a retry on a fresh pty listens to that pty only', async () => {
    const THIRD_PTY = 'wt1@@pty-3'
    const { result, rerender, surface } = setup({ current: null })
    await relaunch(result)
    rerender({ targetPtyId: NEW_PTY })
    rerender({ targetPtyId: null })
    await tick()
    expect(result.current.status?.phase).toBe('failed')
    expect(liveWatcherCount(NEW_PTY)).toBe(0)
    useAppStore.getState().consumePendingCodexPaneRestart(OLD_PTY)
    useAppStore.getState().takeCodexPaneRestartStartup(OLD_PTY)
    rerender({ targetPtyId: OLD_PTY })
    await relaunch(result)
    rerender({ targetPtyId: THIRD_PTY })
    feedLive(NEW_PTY, 'gpt-5.5 high · ~/repo\n')
    await tick()
    expect(result.current.status?.phase).toBe('verifying')
    feedLive(THIRD_PTY, 'gpt-5.5 high · ~/repo\n')
    await tick()
    expect(result.current.status?.phase).toBe('confirmed')
    expect(surface.confirmRelaunchedSessionOptions).toHaveBeenCalledOnce()
  })

  it('fails when the new pty disappears before a header', async () => {
    const { result, rerender, screen, surface } = setup()
    await relaunch(result)
    screen.current = null
    rerender({ targetPtyId: NEW_PTY })
    rerender({ targetPtyId: null })
    await tick()
    expect(result.current.status?.phase).toBe('failed')
    expect(surface.dropDispatchedSessionOptions).toHaveBeenCalledOnce()
    expect(mocks.toast.error).toHaveBeenCalledWith(
      "Codex didn't come back after the restart. Open Terminal to see what happened."
    )
  })

  it('fails when no pty flip happens within 10 s and dequeues the restart', async () => {
    const { result, surface } = setup()
    await relaunch(result)
    expect(useAppStore.getState().pendingCodexPaneRestartIds).toEqual({ [OLD_PTY]: true })
    await tick(10_000)
    expect(result.current.status?.phase).toBe('failed')
    expect(useAppStore.getState().pendingCodexPaneRestartIds).toEqual({})
    expect(useAppStore.getState().pendingCodexPaneRestartStartupByPtyId).toEqual({})
    expect(surface.dropDispatchedSessionOptions).toHaveBeenCalledOnce()
    expect(mocks.toast.error).toHaveBeenCalledWith("The restart didn't start. Try again.")
  })

  it('keeps restarting past 10 s once an executor has claimed the restart, then verifies on the flip', async () => {
    const { result, rerender, surface } = setup()
    await relaunch(result)
    // TerminalPane's drain effect: claim the restart and take its startup, then spawn slowly.
    const store = useAppStore.getState()
    expect(store.consumePendingCodexPaneRestart(OLD_PTY)).toBe(true)
    expect(store.takeCodexPaneRestartStartup(OLD_PTY)).not.toBeNull()

    await tick(10_000)
    expect(result.current.status?.phase).toBe('restarting')
    expect(surface.dropDispatchedSessionOptions).not.toHaveBeenCalled()
    expect(mocks.toast.error).not.toHaveBeenCalled()

    await tick(5_000)
    rerender({ targetPtyId: NEW_PTY })
    expect(result.current.status).toMatchObject({ phase: 'verifying', newPtyId: NEW_PTY })
  })

  it('fails a claimed restart whose pty never flips at the 30 s deadline', async () => {
    const { result, surface } = setup()
    await relaunch(result)
    useAppStore.getState().consumePendingCodexPaneRestart(OLD_PTY)
    useAppStore.getState().takeCodexPaneRestartStartup(OLD_PTY)

    await tick(29_900)
    expect(result.current.status?.phase).toBe('restarting')
    await tick(200)
    expect(result.current.status?.phase).toBe('failed')
    expect(surface.dropDispatchedSessionOptions).toHaveBeenCalledOnce()
    expect(mocks.toast.error).toHaveBeenCalledWith(
      "Codex didn't come back after the restart. Open Terminal to see what happened."
    )
  })

  it('settles unverified at the 30 s deadline unless the pane is proven back at its shell', async () => {
    const seen = setup()
    await relaunch(seen.result)
    seen.screen.current = null
    seen.rerender({ targetPtyId: NEW_PTY })
    await tick(30_300)
    expect(seen.result.current.status?.phase).toBe('unverified')
    // Truth unknown: the requested values stop claiming "sent" — the picker
    // must not report them as dispatched forever.
    expect(seen.surface.dropDispatchedSessionOptions).toHaveBeenCalledOnce()
    expect(seen.surface.confirmRelaunchedSessionOptions).not.toHaveBeenCalled()
    expect(mocks.toast.warning).toHaveBeenCalledWith(
      "Codex resumed but hasn't reported its model yet. Open Terminal to check."
    )
    seen.unmount()

    resetCodexResumeRelaunchForTests()
    useAppStore.setState(useAppStore.getInitialState(), true)
    seedStore()
    const atShell = setup()
    await relaunch(atShell.result)
    atShell.screen.current = null
    atShell.rerender({ targetPtyId: NEW_PTY })
    // OSC 133;D proved the shell is back in front with no agent: Codex never came up.
    useAppStore.setState({
      paneForegroundAgentByPaneKey: { [PANE]: { agent: null, shellForeground: true } }
    })
    await tick(30_300)
    expect(atShell.result.current.status?.phase).toBe('failed')
    expect(atShell.surface.dropDispatchedSessionOptions).toHaveBeenCalledOnce()
    expect(mocks.toast.error).toHaveBeenCalledWith(
      "Codex didn't come back after the restart. Open Terminal to see what happened."
    )
  })

  it('exposes no relaunch for other agents', () => {
    const { result } = renderHook(() =>
      useCodexResumeRelaunch({
        agent: 'claude',
        paneKey: PANE,
        terminalTabId: 'tab-1',
        targetPtyId: OLD_PTY,
        isWorking: false,
        surface: null
      })
    )
    expect(result.current.relaunchSessionOptions).toBeUndefined()
  })
})
