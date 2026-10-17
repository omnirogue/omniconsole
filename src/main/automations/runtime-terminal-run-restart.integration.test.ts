import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import { AutomationService } from './service'
import {
  createRuntimeAutomationRunTerminalObserver,
  type AutomationRunTerminalHost
} from './runtime-terminal-run-observer'

const testState = { dir: '' }
vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  ipcMain: { handle: () => {} },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  }
}))

async function loadStore() {
  vi.resetModules()
  installFakeAppEnvironment({ getPath: () => testState.dir })
  const { Store, initDataPath } = await import('../persistence')
  initDataPath()
  return new Store()
}

const paneKey = 'tab:11111111-2222-4333-8444-555555555555'
const providerSessionId = 'aaaaaaaa-1111-4222-8333-bbbbbbbbbbbb'
const target = {
  workspaceId: 'wt1',
  terminalSessionId: 'tab',
  terminalPaneKey: paneKey,
  terminalPtyId: 'pty-1',
  ownsTerminal: true
}

describe('persisted automation observation after runtime restart', () => {
  const services: AutomationService[] = []
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'omni-run-restart-'))
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-03T19:15:00Z'))
  })
  afterEach(() => {
    for (const service of services.splice(0)) {
      service.stop()
    }
    vi.useRealTimers()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it.each(['finished', 'still-working', 'previous-turn', 'legacy-unbound', 'replacement'] as const)(
    'keeps the persisted run truthful and its pane intact: %s',
    async (caseName) => {
      const store = await loadStore()
      store.addRepo({
        id: 'repo',
        path: '/repo',
        displayName: 'test',
        badgeColor: '#fff',
        addedAt: 1
      })
      const automation = store.createAutomation({
        name: 'Restart regression',
        prompt: 'Produce the current report',
        agentId: 'claude',
        projectId: 'repo',
        workspaceMode: 'existing',
        workspaceId: 'wt1',
        timezone: 'UTC',
        rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
        dtstart: Date.now(),
        enabled: false
      })
      const created = store.createAutomationRun(automation, Date.now(), 'manual')
      const run = store.updateAutomationRun(
        {
          runId: created.id,
          status: 'dispatched',
          ...target,
          providerSession: { providerSessionId, providerSessionAgent: 'claude' }
        },
        caseName === 'legacy-unbound' ? undefined : 'pty-1:inc-1'
      )
      expect(run.dispatchedAt).toBe(Date.now())
      const closeTerminal = vi.fn(async () => undefined)
      let state: 'working' | 'idle' = 'working'
      let incarnation = 'pty-1:inc-1'
      let hook = {
        state: 'working',
        stateStartedAt: Date.now(),
        updatedAt: Date.now(),
        agentType: 'claude',
        onAttachedPty: true,
        providerSession: { key: 'session_id' as const, id: providerSessionId },
        observation: {
          origin: 'hook' as const,
          kind: 'transition' as const,
          authorityId: 'runtime-after-restart',
          incarnation: 1,
          revision: 1,
          observedAt: Date.now()
        }
      }
      const runtime: AutomationRunTerminalHost = {
        getTerminalHandleForPaneKey: (key) => (key === paneKey ? 'handle-1' : null),
        getTerminalProcessIncarnation: () => incarnation,
        showTerminal: async () => ({ ptyId: 'pty-1' }),
        closeTerminal,
        getFreshAgentHookStatusForHandle: () => hook,
        getTerminalAgentStatus: async () => ({ isRunningAgent: true, status: state }),
        readTerminal: async () => ({ tail: ['The current report was preserved.'] }),
        waitForTerminal: async (_handle, options) => {
          if (state === 'idle') {
            return { satisfied: true }
          }
          return new Promise((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => reject(new Error('request_aborted')), {
              once: true
            })
          })
        }
      }
      const first = new AutomationService(store, {
        terminalObserver: createRuntimeAutomationRunTerminalObserver(runtime)
      })
      services.push(first)
      first.start()
      first.setRendererReady()
      await vi.advanceTimersByTimeAsync(1_000)
      first.stop()
      store.flush()
      store.freezeWrites()

      await vi.advanceTimersByTimeAsync(60_000)
      const restored = await loadStore()
      expect(restored.listAutomationRuns(automation.id)[0]?.status).toBe('dispatched')
      expect(restored.listAutomationRuns(automation.id)[0]?.terminalProcessIncarnation).toBe(
        caseName === 'legacy-unbound' ? undefined : 'pty-1:inc-1'
      )
      state = 'idle'
      if (caseName === 'replacement') {
        incarnation = 'pty-1:inc-2'
      }
      hook = {
        ...hook,
        state: caseName === 'still-working' ? 'working' : 'done',
        stateStartedAt: caseName === 'previous-turn' ? run.dispatchedAt! - 1 : Date.now(),
        updatedAt: Date.now(),
        observation: { ...hook.observation, observedAt: Date.now(), revision: 2 }
      }
      const second = new AutomationService(restored, {
        terminalObserver: createRuntimeAutomationRunTerminalObserver(runtime)
      })
      services.push(second)
      second.start()
      second.setRendererReady()
      await vi.advanceTimersByTimeAsync(150_000)

      const final = restored.listAutomationRuns(automation.id)[0]!
      expect(final.status).toBe(caseName === 'finished' ? 'completed' : 'dispatched')
      expect(final.error).toBeNull()
      expect(closeTerminal).not.toHaveBeenCalled()
      if (caseName === 'finished') {
        expect(final.outputSnapshot?.content).toContain('The current report was preserved.')
      }
      second.stop()
      restored.flush()
      restored.freezeWrites()
      const durable = await loadStore()
      expect(durable.listAutomationRuns(automation.id)[0]?.status).toBe(final.status)
      durable.freezeWrites()
    }
  )
})
