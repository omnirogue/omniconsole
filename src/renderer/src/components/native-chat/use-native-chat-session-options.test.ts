// @vitest-environment happy-dom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CatalogModel } from '../../../../shared/agent-session-option-catalog'
import { clearNativeChatModelEnrichmentForTests } from './native-chat-session-option-enrichment'
import {
  beginCodexResumeRelaunch,
  resetCodexResumeRelaunchForTests
} from './codex-resume-relaunch-state'
import {
  clearNativeChatSessionOptionCacheForTests,
  writeNativeChatSessionOptionCache
} from './native-chat-session-option-cache'

const discoverModels = vi.fn<() => Promise<readonly CatalogModel[] | null>>()

vi.mock('./native-chat-session-option-discovery', () => ({
  resolveNativeChatModelDiscoveryContext: () => ({ hostKey: 'host', runtime: null }),
  discoverNativeChatCatalogModels: () => discoverModels()
}))

vi.mock('../../store', () => ({
  useAppStore: Object.assign(() => undefined, {
    getState: () => ({ settings: {}, updateSettings: async () => undefined })
  })
}))

import { useNativeChatSessionOptions } from './use-native-chat-session-options'

// A 1M-context Opus session: the frame names the resolved model while the
// host's discovered catalog names the alias.
const CLAUDE_SCREEN =
  'Claude Code v2.1.220\r\nOpus 5 (1M context) with high effort · API Usage Billing\r\n~/repo'

const DISCOVERED: CatalogModel[] = [
  { id: 'opus[1m]', label: 'Opus (1M context)', options: [] },
  { id: 'haiku', label: 'Haiku', options: [] }
]

function modelDescriptor(snapshot: { id: string; kind: unknown }[]): {
  currentValue?: string
  choices: { value: string }[]
} {
  const model = snapshot.find((descriptor) => descriptor.id === 'model')
  return model?.kind as { currentValue?: string; choices: { value: string }[] }
}

describe('useNativeChatSessionOptions model reporting', () => {
  afterEach(cleanup)

  beforeEach(() => {
    clearNativeChatModelEnrichmentForTests()
    clearNativeChatSessionOptionCacheForTests()
    resetCodexResumeRelaunchForTests()
    discoverModels.mockReset()
    Object.defineProperty(window, 'api', { configurable: true, value: undefined })
  })

  it('restores OMP full provider identity and updates a reported switch without sending a command', async () => {
    discoverModels.mockResolvedValue([
      { id: 'openrouter/google/gemini-2.5-flash-lite', label: 'Gemini', options: [] },
      { id: 'google/gemini-2.5-flash-lite', label: 'Gemini', options: [] }
    ])
    const dispatchCommand = vi.fn()
    const { result, rerender, unmount } = renderHook(
      ({ reportedModel }) =>
        useNativeChatSessionOptions({
          agent: 'omp',
          terminalTabId: 'omp-tab',
          paneKey: 'omp-tab:leaf',
          targetPtyId: 'omp-pty',
          isWorking: false,
          dispatchCommand,
          reportedModel
        }),
      { initialProps: { reportedModel: 'openrouter/google/gemini-2.5-flash-lite' } }
    )
    await waitFor(() =>
      expect(modelDescriptor(result.current.snapshot).currentValue).toBe(
        'openrouter/google/gemini-2.5-flash-lite'
      )
    )
    rerender({ reportedModel: 'google/gemini-2.5-flash-lite' })
    await waitFor(() =>
      expect(modelDescriptor(result.current.snapshot).currentValue).toBe(
        'google/gemini-2.5-flash-lite'
      )
    )
    expect(dispatchCommand).not.toHaveBeenCalled()
    unmount()
  })

  it.each([
    ['gpt-5.5', 'medium'],
    ['gpt-6-astra', 'default']
  ])(
    'reports %s %s drawn after resumed Chat mounts, then stops observing',
    async (model, effort) => {
      vi.useFakeTimers()
      discoverModels.mockReturnValue(new Promise(() => {}))
      let frame: string | null = null
      const readTerminalScreen = vi.fn(() => frame)
      const dispatchCommand = vi.fn()
      const { result, unmount } = renderHook(() =>
        useNativeChatSessionOptions({
          agent: 'codex',
          terminalTabId: 'resumed-tab',
          paneKey: 'resumed-tab:leaf',
          targetPtyId: 'resumed-pty',
          isWorking: false,
          dispatchCommand,
          readTerminalScreen
        })
      )
      try {
        frame = `› Ask Codex to do anything\n\n${model} ${effort} · ~/repo`
        // Why 1000: the resumed-header retry polls every second since 85b625668b (was 250 ms).
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1000)
        })
        expect(modelDescriptor(result.current.snapshot).currentValue).toBe(model)
        if (effort === 'default') {
          const reportedEffort = result.current.snapshot.find((entry) => entry.id === 'effort')
          expect(reportedEffort?.valueSource).toBe('unknown')
          expect(reportedEffort?.kind).not.toHaveProperty('currentValue')
        }
        const reads = readTerminalScreen.mock.calls.length
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1000)
        })
        expect(readTerminalScreen).toHaveBeenCalledTimes(reads)
      } finally {
        unmount()
        vi.useRealTimers()
      }
    }
  )

  it('keeps the dispatched values across the pty flip while a Codex relaunch is in flight', async () => {
    // Why: the killed TUI never leaves the alternate screen, so the mounted xterm
    // still shows its footer when the replacement pty binds. Neither the surface
    // rebuild nor the scrape effect may report that frozen frame as truth.
    discoverModels.mockReturnValue(new Promise(() => {}))
    const paneKey = 'tab-relaunch:leaf-1'
    writeNativeChatSessionOptionCache('tab-relaunch', {
      agent: 'codex',
      model: { value: 'gpt-5.5', source: 'dispatched' },
      valuesByModel: { 'gpt-5.5': { effort: { value: 'high', source: 'dispatched' } } }
    })
    beginCodexResumeRelaunch(paneKey, {
      phase: 'restarting',
      requested: { model: 'gpt-5.5', effort: 'high' },
      selectedOption: 'effort',
      threadId: 'thread-1',
      previousPtyId: 'pty-old',
      startedAt: Date.now()
    })
    const dispatchCommand = vi.fn()
    const { result, rerender, unmount } = renderHook(
      ({ targetPtyId }) =>
        useNativeChatSessionOptions({
          agent: 'codex',
          terminalTabId: 'tab-relaunch',
          paneKey,
          targetPtyId,
          isWorking: false,
          dispatchCommand,
          readTerminalScreen: () => 'gpt-5.5 medium · ~/repo'
        }),
      { initialProps: { targetPtyId: 'pty-old' as string | null } }
    )

    rerender({ targetPtyId: 'pty-new' })
    expect(result.current.relaunchStatus?.phase).toBe('verifying')
    // Let the scrape effect's async body settle before reading the snapshot.
    await Promise.resolve()
    await Promise.resolve()

    const descriptor = (id: string) => result.current.snapshot.find((entry) => entry.id === id)
    expect(descriptor('model')).toMatchObject({
      valueSource: 'dispatched',
      kind: { currentValue: 'gpt-5.5' }
    })
    expect(descriptor('effort')).toMatchObject({
      valueSource: 'dispatched',
      kind: { currentValue: 'high' }
    })
    unmount()
  })

  it('re-resolves the reported model against models discovered after the read', async () => {
    // Why: discovery is async, so the first scrape can only reach the seed. If
    // the reported id were left at the family the picker would show a row it
    // had to invent — and by then the frame may have scrolled out of the buffer,
    // so re-reading the screen is not an option.
    let resolveDiscovery: (models: CatalogModel[]) => void = () => {}
    discoverModels.mockReturnValue(
      new Promise<readonly CatalogModel[]>((resolve) => {
        resolveDiscovery = resolve
      })
    )

    // Stable identity, and the frame scrolls out of the buffer before discovery
    // lands — so nothing but the cached screen can drive the re-resolution.
    let frameVisible = true
    const readTerminalScreen = (): string | null =>
      frameVisible ? CLAUDE_SCREEN : 'conversation has scrolled past the frame'
    const dispatchCommand = vi.fn()

    const { result } = renderHook(() =>
      useNativeChatSessionOptions({
        agent: 'claude',
        terminalTabId: 'tab-1',
        paneKey: 'tab-1:leaf-1',
        isWorking: false,
        targetPtyId: 'pty-1',
        dispatchCommand,
        readTerminalScreen
      })
    )

    await waitFor(() => expect(modelDescriptor(result.current.snapshot).currentValue).toBe('opus'))

    frameVisible = false
    resolveDiscovery(DISCOVERED)

    await waitFor(() =>
      expect(modelDescriptor(result.current.snapshot).currentValue).toBe('opus[1m]')
    )
    // The invented family row is gone: every choice is one the host listed.
    expect(modelDescriptor(result.current.snapshot).choices.map((choice) => choice.value)).toEqual([
      'opus[1m]',
      'haiku'
    ])
  })

  it('does not re-resolve a late snapshot from the previous pty', async () => {
    let resolveDiscovery: (models: CatalogModel[]) => void = () => {}
    discoverModels.mockReturnValue(
      new Promise<readonly CatalogModel[]>((resolve) => {
        resolveDiscovery = resolve
      })
    )
    let resolveOldSnapshot: (snapshot: { data: string; alternateScreen: false }) => void = () => {}
    const oldSnapshot = new Promise<{ data: string; alternateScreen: false }>((resolve) => {
      resolveOldSnapshot = resolve
    })
    const getMainBufferSnapshot = vi
      .fn()
      .mockReturnValueOnce(oldSnapshot)
      .mockReturnValueOnce(new Promise(() => {}))
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { pty: { getMainBufferSnapshot } }
    })

    const dispatchCommand = vi.fn()
    const { result, rerender } = renderHook(
      ({ targetPtyId }) =>
        useNativeChatSessionOptions({
          agent: 'claude',
          terminalTabId: 'tab-1',
          paneKey: 'tab-1:leaf-1',
          isWorking: false,
          targetPtyId,
          dispatchCommand,
          readTerminalScreen: () => null
        }),
      { initialProps: { targetPtyId: 'pty-old' } }
    )

    rerender({ targetPtyId: 'pty-new' })
    resolveOldSnapshot({ data: CLAUDE_SCREEN, alternateScreen: false })
    await Promise.resolve()
    resolveDiscovery(DISCOVERED)

    await waitFor(() =>
      expect(
        modelDescriptor(result.current.snapshot).choices.map((choice) => choice.value)
      ).toEqual(['opus[1m]', 'haiku'])
    )
    expect(modelDescriptor(result.current.snapshot).currentValue).toBeUndefined()
  })

  it('clears a previously reported screen when the target pty changes', async () => {
    let resolveDiscovery: (models: CatalogModel[]) => void = () => {}
    discoverModels.mockReturnValue(
      new Promise<readonly CatalogModel[]>((resolve) => {
        resolveDiscovery = resolve
      })
    )
    const getMainBufferSnapshot = vi
      .fn()
      .mockResolvedValueOnce({ data: CLAUDE_SCREEN, alternateScreen: false })
      .mockReturnValueOnce(new Promise(() => {}))
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { pty: { getMainBufferSnapshot } }
    })

    const dispatchCommand = vi.fn()
    const { result, rerender } = renderHook(
      ({ targetPtyId }) =>
        useNativeChatSessionOptions({
          agent: 'claude',
          terminalTabId: 'tab-reset',
          paneKey: 'tab-reset:leaf-1',
          targetPtyId,
          isWorking: false,
          dispatchCommand,
          readTerminalScreen: () => null
        }),
      { initialProps: { targetPtyId: 'pty-reported' } }
    )
    await waitFor(() => expect(modelDescriptor(result.current.snapshot).currentValue).toBe('opus'))

    rerender({ targetPtyId: 'pty-empty' })
    resolveDiscovery(DISCOVERED)

    await waitFor(() =>
      expect(
        modelDescriptor(result.current.snapshot).choices.map((choice) => choice.value)
      ).toEqual(['opus[1m]', 'haiku'])
    )
    expect(modelDescriptor(result.current.snapshot).currentValue).toBeUndefined()
  })
})
