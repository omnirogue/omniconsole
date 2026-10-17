/**
 * C3 / plan step 4 at the RPC entry: `session.tabs.activate` classifies an unavailable or
 * incomplete owner inventory as a retryable refusal before any missing-row check can answer
 * `tab_not_found`, for both paired runtime clients and phones. Capability-hidden rows stay hidden.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setRuntimeDesktopSurface } from '../../runtime-desktop-surface'
import { RpcDispatcher } from '../dispatcher'
import type { RpcDispatchStreamingOptions } from '../dispatcher-stream-options'
import { SESSION_TAB_METHODS } from './session-tabs'
import {
  LEAF,
  TAB,
  WINDOW_ID,
  WT,
  createCallerActivationFixture,
  publishWindowTabs
} from '../../caller-session-tab-activation-fixture'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

afterEach(() => {
  setRuntimeDesktopSurface(null)
})

type Reply = { ok: boolean; error?: { code: string; message: string; data?: unknown } }

async function activate(
  fixture: ReturnType<typeof createCallerActivationFixture>,
  clientKind: 'runtime' | 'mobile',
  params: Record<string, unknown> = {}
): Promise<Reply> {
  const dispatcher = new RpcDispatcher({ runtime: fixture.runtime, methods: SESSION_TAB_METHODS })
  const options: RpcDispatchStreamingOptions = {
    clientKind,
    pairedDeviceId: clientKind === 'mobile' ? 'phone-1' : 'macbook-1',
    clientCapabilities: []
  }
  const replies: string[] = []
  await dispatcher.dispatchStreaming(
    {
      id: 'request-1',
      authToken: 'token',
      method: 'session.tabs.activate',
      params: { worktree: `id:${WT}`, tabId: TAB, leafId: LEAF, ...params }
    },
    (response) => replies.push(response),
    options
  )
  return JSON.parse(replies[0]!) as Reply
}

describe.each(['runtime', 'mobile'] as const)('session.tabs.activate from a %s client', (kind) => {
  it('refuses retryably while the window has published no inventory, creating nothing', async () => {
    const fixture = createCallerActivationFixture()
    fixture.runtime.attachWindow(WINDOW_ID)
    fixture.runtime.syncWindowGraph(WINDOW_ID, { tabs: [], leaves: [] })

    const reply = await activate(fixture, kind, { navigation: 'caller', intent: 'user' })

    expect(reply.ok).toBe(false)
    expect(reply.error).toMatchObject({
      code: 'session_tab_unverifiable',
      data: { retryable: true, reason: 'inventory-not-authoritative' }
    })
    expect(reply.error?.message).not.toContain('tab_not_found')
    expect(fixture.spawn).not.toHaveBeenCalled()
  })

  it('answers tab_not_found for a workspace absent from a complete inventory', async () => {
    const fixture = createCallerActivationFixture()
    fixture.runtime.attachWindow(WINDOW_ID)
    fixture.runtime.syncWindowGraph(WINDOW_ID, { tabs: [], leaves: [], mobileSessionTabs: [] })

    const reply = await activate(fixture, kind, { intent: 'user' })

    expect(reply.error?.message).toBe('tab_not_found')
    expect(fixture.spawn).not.toHaveBeenCalled()
  })

  it('refuses retryably while the window reloads a row it listed', async () => {
    const fixture = createCallerActivationFixture()
    publishWindowTabs(fixture.runtime, [{ tabId: TAB, leafId: LEAF }])
    fixture.runtime.markRendererReloading(WINDOW_ID)

    const reply = await activate(fixture, kind, { navigation: 'caller', intent: 'user' })

    expect(reply.error?.code).toBe('session_tab_unverifiable')
    expect(fixture.spawn).not.toHaveBeenCalled()
    expect(fixture.mountRequests).toEqual([])
  })

  it('answers tab_not_found only for confirmed absence from the current publication', async () => {
    const fixture = createCallerActivationFixture()
    publishWindowTabs(fixture.runtime, [])

    const reply = await activate(fixture, kind, { intent: 'user' })

    expect(reply.ok).toBe(false)
    expect(reply.error?.message).toBe('tab_not_found')
    expect(fixture.spawn).not.toHaveBeenCalled()
  })
})

describe('the phone caller-navigation path', () => {
  it('mounts a window-listed pane on the desktop for a tap, without spawning or moving focus', async () => {
    const fixture = createCallerActivationFixture()
    publishWindowTabs(fixture.runtime, [{ tabId: TAB, leafId: LEAF }])

    // Why no navigation: a phone omits it, and a paired client kind resolves to 'caller'.
    const reply = await activate(fixture, 'mobile', { notifyClients: false, intent: 'user' })

    expect(reply.ok).toBe(true)
    expect(fixture.spawn).not.toHaveBeenCalled()
    expect(fixture.focusTerminal).not.toHaveBeenCalled()
    expect(fixture.mountRequests).toEqual([
      expect.objectContaining({ worktreeId: WT, tabId: TAB, leafId: LEAF, personOpen: true })
    ])
  })
})

describe('capability visibility', () => {
  it('keeps a capability-hidden row tab_not_found without consulting inventory availability', async () => {
    const hidden = {
      worktree: WT,
      publicationEpoch: 'renderer:window',
      snapshotVersion: 1,
      activeGroupId: null,
      activeTabId: 'page-1',
      activeTabType: 'browser',
      tabs: [
        {
          type: 'browser',
          id: 'page-1',
          browserPageId: 'page-1',
          browserWorkspaceId: 'page-1',
          title: 'Client page',
          url: 'https://example.com',
          placement: { kind: 'client', clientId: 'other' },
          isActive: true
        }
      ]
    }
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      listMobileSessionTabs: vi.fn().mockResolvedValue(hidden),
      rejectMissingSessionTabActivation: vi.fn(),
      activateMobileSessionTab: vi.fn()
    }
    const dispatcher = new RpcDispatcher({
      runtime: runtime as never,
      methods: SESSION_TAB_METHODS
    })
    const replies: string[] = []

    await dispatcher.dispatchStreaming(
      {
        id: 'request-1',
        authToken: 'token',
        method: 'session.tabs.activate',
        params: { worktree: `id:${WT}`, tabId: 'page-1' }
      },
      (response) => replies.push(response),
      { clientKind: 'runtime', pairedDeviceId: 'legacy', clientCapabilities: [] }
    )

    expect(JSON.parse(replies[0]!).error.message).toBe('tab_not_found')
    expect(runtime.rejectMissingSessionTabActivation).not.toHaveBeenCalled()
    expect(runtime.activateMobileSessionTab).not.toHaveBeenCalled()
  })
})
