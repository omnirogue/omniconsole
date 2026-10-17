/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { selectConsoleAccountScope } from '@/lib/console-account-scope'
import { useAppStore } from '@/store'
import { useReadyPaneDrafts, updateReadyPane } from '@/store/ready-pane-drafts'
import ReadyPane from './ReadyPane'

const mocks = vi.hoisted(() => ({ send: vi.fn(), recover: vi.fn(), reconcile: vi.fn() }))
vi.mock('@/store', async () => {
  const { create } = await import('zustand')
  const { getDefaultSettings } = await import('../../../../shared/constants')
  return {
    useAppStore: create(() => ({
      activeOrcaProfileId: 'one',
      orcaProfileAuthStatus: null,
      settings: getDefaultSettings('/tmp'),
      rateLimits: {},
      folderWorkspaces: [],
      worktreesByRepo: {}
    }))
  }
})
vi.mock('@/lib/worktree-runtime-owner', () => ({ getSettingsForWorktreeRuntimeOwner: () => ({}) }))
vi.mock('@/hooks/useAgentDetectionTarget', () => ({
  getAgentDetectionTargetKeyForWorktree: () => 'local',
  parseAgentDetectionTargetKey: () => ({ kind: 'local' })
}))
vi.mock('@/hooks/useWorkAgentCapabilities', () => ({ workAgentModelProbeOwner: () => 'cached' }))
vi.mock('@/hooks/work-agent-model-probes', async () => {
  const { create } = await import('zustand')
  return {
    useWorkAgentModelProbes: create(() => ({ probes: {} })),
    workAgentModelListingPolicy: () => ({ lifetimeMs: 60_000 })
  }
})
vi.mock('./ready-pane-launch', () => ({
  sendReadyPane: mocks.send,
  recoverReadyPaneLaunches: mocks.recover,
  reconcileReadyPane: mocks.reconcile
}))
let scope: string
beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  useReadyPaneDrafts.setState({ documents: {}, errors: {} })
  scope = selectConsoleAccountScope(useAppStore.getState())
  // Any daemon call here is a waiting-cost regression.
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: new Proxy(
      {},
      {
        get: () => {
          throw new Error('Idle pane contacted the daemon')
        }
      }
    )
  })
})
afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'api')
})
describe('an idle ready pane', () => {
  it('renders cached preferences with a stale label and makes no launch or daemon call', () => {
    render(<ReadyPane paneId="ready" />)
    expect(screen.getByRole('tab', { name: 'Claude' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByText('Model list may be out of date. Verified on Send.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Send' }).hasAttribute('disabled')).toBe(true)
    expect(mocks.send).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(document.body)
  })
  it('switches provider drafts instantly and retains each across an unmount', () => {
    const mounted = render(<ReadyPane paneId="ready" />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), {
      target: { value: 'Claude draft' }
    })
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Codex' }), { button: 0, ctrlKey: false })
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), {
      target: { value: 'Codex draft' }
    })
    expect(useReadyPaneDrafts.getState().documents[scope].panes.ready.drafts).toMatchObject({
      claude: { text: 'Claude draft' },
      codex: { text: 'Codex draft' }
    })
    mounted.unmount()
    useReadyPaneDrafts.setState({ documents: {}, errors: {} })
    render(<ReadyPane paneId="ready" />)
    expect((screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement).value).toBe(
      'Codex draft'
    )
    expect(mocks.send).not.toHaveBeenCalled()
  })
  it('keeps an uncertain draft and exposes reconciliation without another Send', () => {
    updateReadyPane(scope, 'ready', (pane) => ({
      ...pane,
      drafts: { ...pane.drafts, claude: { text: 'Keep me' } },
      submission: {
        id: 'one',
        provider: 'claude',
        status: 'uncertain',
        timings: { submitted: Date.now() },
        error: 'Check existing session'
      }
    }))
    render(<ReadyPane paneId="ready" />)
    expect(screen.getByRole('button', { name: 'Send' }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Check for session' }))
    expect(mocks.reconcile).toHaveBeenCalledWith(scope, 'ready')
    expect(mocks.send).not.toHaveBeenCalled()
    expect((screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement).value).toBe(
      'Keep me'
    )
  })
})
