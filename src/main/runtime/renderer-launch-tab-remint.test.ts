import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './omni-runtime'
import { setRuntimeDesktopSurface } from './runtime-desktop-surface'
import {
  _resetLaunchTriggerHintsForTests,
  takeLaunchCauseHints
} from '../observability/launch-trigger-hints'
import { runPtyIpcSpawn } from '../ipc/pty/ipc/spawn-run'
import { registerLaunchLedgerTestDirectory } from '../launch-ledger/launch-ledger-test-directory'
const readRows = registerLaunchLedgerTestDirectory()
vi.mock('../ipc/pty/ipc/interrupted-resume', () => ({ prepareInterruptedResume: () => null }))
vi.mock('../ipc/pty/ipc/spawn-begin', () => ({
  beginPtyIpcSpawn: async () => ({ id: 'pty-99', isReattach: true })
}))

const fixture = vi.hoisted(() => ({ store: {} as Record<string, unknown> }))
vi.mock('../../renderer/src/store', () => ({ useAppStore: { getState: () => fixture.store } }))
vi.mock('@/components/terminal/background-terminal-worktree-mount', () => ({
  requestBackgroundTerminalWorktreeMount: vi.fn()
}))
vi.mock('@/lib/terminal-worktree-route', () => ({
  resolveTerminalWorktreeRoute: () => ({ runtimeEnvironmentId: null })
}))
vi.mock('@/lib/session-title-change', () => ({ titleNewTerminalTab: vi.fn() }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

afterEach(() => {
  setRuntimeDesktopSurface(null)
  _resetLaunchTriggerHintsForTests()
  vi.unstubAllGlobals()
})
const requested = '11111111-1111-4111-8111-111111111111'
const actual = '22222222-2222-4222-8222-222222222222'
describe('renderer final tab launch identity', () => {
  it.each([requested, `  ${requested}  `, 'privateprompttext-caller-tab'])(
    'uses the real bridge reply before startup reads the hint: %s',
    async (tabId) => {
      const runtime = new OrcaRuntimeService()
      let listener: (...args: never[]) => void
      let bridge: (data: never) => void
      const order: string[] = []
      let spawning: ReturnType<typeof runPtyIpcSpawn> | undefined
      const launchCause = {
        trigger: 'terminal-create' as const,
        requestId: actual,
        actor: { kind: 'paired-device' as const, deviceId: requested }
      }
      const createTab = vi.fn((_worktreeId, _groupId, _type, options?: { id?: string }) => ({
        id: options?.id ?? actual,
        title: 'Shell'
      }))
      fixture.store = {
        activeWorktreeId: 'folder:33333333-3333-4333-8333-333333333333',
        createTab,
        queueTabStartupCommand: (allocatedTabId: string) => {
          order.push('spawn')
          spawning = runPtyIpcSpawn({} as never, {
            cols: 80,
            rows: 24,
            command: 'codex',
            tabId: allocatedTabId,
            worktreeId: fixture.store.activeWorktreeId as string
          })
        }
      }
      const webContents = { send: vi.fn((_channel: string, payload: never) => bridge(payload)) }
      vi.stubGlobal('window', {
        api: {
          ui: {
            onRequestTerminalCreate: (callback: typeof bridge) => {
              bridge = callback
              return () => {}
            },
            replyTerminalCreate: (reply: never) => {
              order.push('reply')
              listener({ sender: webContents } as never, reply)
            }
          }
        }
      })
      // Keep this cross-process integration fixture outside the node project's static renderer imports.
      const bridgeModule = '../../renderer/src/hooks/ipc-events/terminal-request-ipc-bridge'
      const { registerTerminalRequestIpcBridge } = await import(bridgeModule)
      registerTerminalRequestIpcBridge([])
      setRuntimeDesktopSurface({
        showNotification: () => false,
        findWindowById: () => ({ isDestroyed: () => false, webContents }) as never,
        onIpc: (_channel, fn) => {
          listener = fn as never
        },
        removeIpcListener: vi.fn()
      })
      runtime.attachWindow(1)
      runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
      vi.spyOn(
        runtime as unknown as { waitForTerminalHandle: () => Promise<string> },
        'waitForTerminalHandle'
      ).mockResolvedValue('term_test')
      const result = await runtime.createTerminal(undefined, {
        command: 'codex',
        tabId,
        presentation: 'background',
        surfaceOwner: false,
        launchCause
      })
      await spawning
      expect.soft(result.tabId).toBe(actual)
      expect.soft(createTab.mock.calls[0][3]).not.toHaveProperty('id')
      expect.soft(order).toEqual(['reply', 'spawn'])
      expect.soft(await readRows()).toEqual([
        {
          v: 1,
          ts: expect.any(String),
          launchId: expect.any(String),
          pipeline: 'renderer-ipc',
          ptyId: 'pty-99',
          tabId: actual,
          worktreeId: fixture.store.activeWorktreeId,
          cause: launchCause.trigger,
          actor: launchCause.actor,
          requestId: launchCause.requestId,
          hasStartupCommand: true,
          process: 'attached',
          intent: 'attach'
        }
      ])
      expect(takeLaunchCauseHints({ tabId }).tabCause).toBeNull()
    }
  )
})
