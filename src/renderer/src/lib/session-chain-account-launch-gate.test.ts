// Compat gate for an account launch (a step whose actor names a CLAUDE_CONFIG_DIR
// profile): the workspace must be trusted BEFORE the prompt can be delivered, and the
// launch must carry the account env and the submit-after-ready delivery mode. A delivery
// path that writes before trust is marked pastes into a trust dialog.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { launchAgentSessionContinuation } from './launch-agent-session-continuation'

const events = vi.hoisted(() => ({ order: [] as string[] }))
const launchTab = vi.hoisted(() => ({ launchAgentInNewTab: vi.fn() }))
const store = vi.hoisted(() => ({
  state: {
    settings: { disabledTuiAgents: [] as string[] },
    ensureDetectedAgents: vi.fn(async () => ['claude']),
    setActiveTabType: vi.fn()
  }
}))

vi.mock('@/lib/launch-agent-in-new-tab', () => launchTab)
vi.mock('@/store', () => ({ useAppStore: { getState: () => store.state } }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock('@/lib/connection-context', () => ({ getConnectionIdFromState: () => null }))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: () => null
}))
vi.mock('@/lib/local-preflight-context', () => ({
  getLocalAgentPreflightContext: () => ({})
}))
vi.mock('@/lib/agent-catalog', () => ({ getAgentLabel: (agent: string) => agent }))
vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string) => fallback
}))

const ACCOUNT_ENV = { CLAUDE_CONFIG_DIR: '/pool/slot-3' }

describe('launching a chain step under an account profile', () => {
  beforeEach(() => {
    events.order = []
    launchTab.launchAgentInNewTab.mockReset()
    store.state.ensureDetectedAgents.mockClear()
    vi.stubGlobal('window', {
      api: {
        agentTrust: {
          markTrusted: vi.fn(async () => {
            // Two turns of latency: a delivery that does not await this would be observable.
            await Promise.resolve()
            await Promise.resolve()
            events.order.push('trust')
            return { ok: true }
          })
        }
      }
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('marks trust before the tab launches, then delivers the prompt', async () => {
    const delivery: {
      promise: Promise<{ delivered: boolean; failureNotified: boolean }>
      resolve: (value: { delivered: boolean; failureNotified: boolean }) => void
    } = (() => {
      let resolve!: (value: { delivered: boolean; failureNotified: boolean }) => void
      const promise = new Promise<{ delivered: boolean; failureNotified: boolean }>((settle) => {
        resolve = settle
      })
      return { promise, resolve }
    })()
    launchTab.launchAgentInNewTab.mockImplementation(() => {
      events.order.push('launch')
      return {
        tabId: 'tab-new',
        startupPlan: {},
        pasteDraftAfterLaunch: true,
        promptDeliveryResult: delivery.promise
      }
    })
    let delivered: Promise<boolean> | null = null
    const ok = await launchAgentSessionContinuation({
      agent: 'claude',
      prompt: 'continue the queued work',
      worktreeId: 'folder:f1',
      workspacePath: '/Users/me/Webinar',
      launchSource: 'sidebar',
      launchEnv: ACCOUNT_ENV,
      onLaunched: (result) => {
        delivered = result.promptDelivered
      }
    })
    expect(ok).toBe(true)
    // The prompt is only delivered after readiness; nothing was written at launch time.
    expect(events.order).toEqual(['trust', 'launch'])
    events.order.push('deliver')
    delivery.resolve({ delivered: true, failureNotified: false })
    expect(await delivered!).toBe(true)
    expect(events.order).toEqual(['trust', 'launch', 'deliver'])

    const args = launchTab.launchAgentInNewTab.mock.calls[0]?.[0]
    expect(args).toMatchObject({
      agent: 'claude',
      promptDelivery: 'submit-after-ready',
      launchEnv: ACCOUNT_ENV,
      prompt: 'continue the queued work'
    })
    expect(window.api.agentTrust.markTrusted).toHaveBeenCalledWith({
      preset: 'claude',
      workspacePath: '/Users/me/Webinar'
    })
  })

  it('still launches when the best-effort trust write fails', async () => {
    vi.stubGlobal('window', {
      api: {
        agentTrust: {
          markTrusted: vi.fn(async () => {
            events.order.push('trust')
            throw new Error('read-only home')
          })
        }
      }
    })
    launchTab.launchAgentInNewTab.mockImplementation(() => {
      events.order.push('launch')
      return { tabId: 'tab-new', startupPlan: {}, pasteDraftAfterLaunch: true }
    })
    const ok = await launchAgentSessionContinuation({
      agent: 'claude',
      prompt: 'continue the queued work',
      worktreeId: 'folder:f1',
      workspacePath: '/Users/me/Webinar',
      launchSource: 'sidebar',
      launchEnv: ACCOUNT_ENV
    })
    expect(ok).toBe(true)
    expect(events.order).toEqual(['trust', 'launch'])
  })

  it('refuses the launch when the agent is disabled, without touching trust', async () => {
    store.state.settings.disabledTuiAgents = ['claude']
    const ok = await launchAgentSessionContinuation({
      agent: 'claude',
      prompt: 'continue the queued work',
      worktreeId: 'folder:f1',
      workspacePath: '/Users/me/Webinar',
      launchSource: 'sidebar',
      launchEnv: ACCOUNT_ENV
    })
    store.state.settings.disabledTuiAgents = []
    expect(ok).toBe(false)
    expect(events.order).toEqual([])
    expect(launchTab.launchAgentInNewTab).not.toHaveBeenCalled()
  })
})
