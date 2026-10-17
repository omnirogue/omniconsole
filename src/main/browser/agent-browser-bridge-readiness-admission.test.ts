import { describe, it, expect, vi, beforeEach } from 'vitest'

const { execFileMock, webContentsFromIdMock, existsSyncMock, readFileSyncMock, stdinWrites } =
  vi.hoisted(() => ({
    execFileMock: vi.fn(),
    webContentsFromIdMock: vi.fn(),
    existsSyncMock: vi.fn(() => false),
    readFileSyncMock: vi.fn(() => Buffer.from('')),
    stdinWrites: [] as string[]
  }))

vi.mock('child_process', () => ({ execFile: execFileMock }))
vi.mock('fs', () => ({
  existsSync: existsSyncMock,
  readFileSync: readFileSyncMock,
  accessSync: vi.fn(),
  chmodSync: vi.fn(),
  constants: { X_OK: 1 }
}))
vi.mock('os', () => ({ platform: () => 'darwin', arch: () => 'arm64' }))
vi.mock('electron', () => {
  return {
    app: { getPath: vi.fn(() => '/app'), getAppPath: vi.fn(() => '/project'), isPackaged: false },
    webContents: { fromId: webContentsFromIdMock }
  }
})
const { CdpWsProxyMock } = vi.hoisted(() => {
  const instances: unknown[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const MockClass = vi.fn().mockImplementation(function (this: any, _wc: unknown) {
    this._wc = _wc
    this.start = vi.fn(async () => 'ws://127.0.0.1:9222')
    this.stop = vi.fn(async () => {})
    this.getPort = vi.fn(() => 9222)
    instances.push(this)
  })
  return { CdpWsProxyMock: Object.assign(MockClass, { instances }) }
})

vi.mock('./cdp-ws-proxy', () => ({
  CdpWsProxy: CdpWsProxyMock
}))
vi.mock('./cdp-bridge', () => ({
  BrowserError: class BrowserError extends Error {
    code: string
    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  }
}))

import { AgentBrowserBridge } from './agent-browser-bridge'
import { clientAutomationGuestNotReady } from './browser-automation-visibility-acquire'
import {
  createSucceedWith,
  mockBrowserManager,
  mockWebContents,
  overrideBridgeWebContentsLookup,
  resetAgentBrowserBridgeMocks,
  type ExecFileCallback
} from './agent-browser-bridge-test-harness'

overrideBridgeWebContentsLookup(AgentBrowserBridge.prototype, webContentsFromIdMock)

const succeedWith = createSucceedWith(execFileMock, stdinWrites)

describe('retained browser readiness before cold command setup', () => {
  beforeEach(() => {
    resetAgentBrowserBridgeMocks({
      webContentsFromIdMock,
      existsSyncMock,
      readFileSyncMock,
      stdinWrites,
      cdpWsProxyInstances: CdpWsProxyMock.instances
    })
    succeedWith({ snapshot: 'tree' })
  })

  it('refuses before any subprocess, proxy or pointer command starts', async () => {
    const b = new AgentBrowserBridge(
      mockBrowserManager(undefined, undefined, {
        captureClientAutomationVisibilityGuard: () => () => {},
        acquireAutomationVisibility: vi.fn().mockRejectedValue(clientAutomationGuestNotReady())
      })
    )
    b.setActiveTab(100)
    await expect(b.click('#activate')).rejects.toMatchObject({
      code: 'browser_client_page_automation_guest_not_ready'
    })
    expect(execFileMock).not.toHaveBeenCalled()
    expect(CdpWsProxyMock).not.toHaveBeenCalled()
    expect(CdpWsProxyMock.instances).toHaveLength(0)
  })

  it('releases the acquired lease when stale-session cleanup fails', async () => {
    const release = vi.fn()
    const b = new AgentBrowserBridge(
      mockBrowserManager(undefined, undefined, {
        acquireAutomationVisibility: async () => release
      })
    )
    b.setActiveTab(100)
    execFileMock.mockImplementation(
      (_bin: string, _args: string[], _opts: unknown, cb: ExecFileCallback) => {
        cb(new Error('cleanup failed'))
      }
    )
    await expect(b.snapshot()).rejects.toMatchObject({ code: 'browser_owner_unavailable' })
    expect(release).toHaveBeenCalledOnce()
    expect(CdpWsProxyMock).not.toHaveBeenCalled()
    expect(execFileMock).toHaveBeenCalledOnce()
    expect(execFileMock.mock.calls[0][1]).toContain('close')
  })

  it('stops a proxy that fails to start and releases its lease', async () => {
    const release = vi.fn()
    const stop = vi.fn(async () => {})
    CdpWsProxyMock.mockImplementationOnce(function () {
      return { start: vi.fn().mockRejectedValue(new Error('proxy failed')), stop }
    })
    const b = new AgentBrowserBridge(
      mockBrowserManager(undefined, undefined, {
        acquireAutomationVisibility: async () => release
      })
    )
    b.setActiveTab(100)
    await expect(b.snapshot()).rejects.toThrow('proxy failed')
    expect(stop).toHaveBeenCalledOnce()
    expect(release).toHaveBeenCalledOnce()
    expect(execFileMock).toHaveBeenCalledOnce()
  })

  it('never transfers a retained proof to a replacement native guest', async () => {
    const tabs = new Map([['tab-1', 100]])
    const release = vi.fn()
    webContentsFromIdMock.mockImplementation((id: number) => mockWebContents(id))
    const b = new AgentBrowserBridge(
      mockBrowserManager(tabs, undefined, {
        captureClientAutomationVisibilityGuard: () => () => {
          if (tabs.get('tab-1') !== 100) {
            throw clientAutomationGuestNotReady()
          }
        },
        acquireAutomationVisibility: async () => {
          tabs.set('tab-1', 200)
          return release
        }
      })
    )
    b.setActiveTab(100)
    await expect(b.snapshot()).rejects.toMatchObject({
      code: 'browser_client_page_automation_guest_not_ready'
    })
    expect(execFileMock).not.toHaveBeenCalled()
    expect(CdpWsProxyMock).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledOnce()
  })

  it('stops newly allocated setup when ownership changes during proxy startup', async () => {
    let current = true
    const release = vi.fn()
    const stop = vi.fn(async () => {})
    CdpWsProxyMock.mockImplementationOnce(function () {
      return {
        start: async () => {
          current = false
          return 'ws://127.0.0.1:9222'
        },
        stop
      }
    })
    const b = new AgentBrowserBridge(
      mockBrowserManager(undefined, undefined, {
        captureClientAutomationVisibilityGuard: () => () => {
          if (!current) {
            throw clientAutomationGuestNotReady()
          }
        },
        acquireAutomationVisibility: async () => release
      })
    )
    b.setActiveTab(100)
    await expect(b.snapshot()).rejects.toMatchObject({
      code: 'browser_client_page_automation_guest_not_ready'
    })
    expect(stop).toHaveBeenCalledOnce()
    expect(release).toHaveBeenCalledOnce()
    expect(execFileMock).toHaveBeenCalledOnce()
    expect(execFileMock.mock.calls[0][1]).toContain('close')
    expect((b as unknown as { sessions: Map<string, unknown> }).sessions.size).toBe(0)
  })

  it('keeps a queued retained command bound to its original owner', async () => {
    let current = true
    let completeSnapshot!: () => void
    const acquire = vi.fn(async () => () => {})
    const b = new AgentBrowserBridge(
      mockBrowserManager(undefined, undefined, {
        captureClientAutomationVisibilityGuard: () => () => {
          if (!current) {
            throw clientAutomationGuestNotReady()
          }
        },
        acquireAutomationVisibility: acquire
      })
    )
    b.setActiveTab(100)
    execFileMock.mockImplementation(
      (_bin: string, args: string[], _opts: unknown, cb: ExecFileCallback) => {
        if (args.includes('snapshot')) {
          completeSnapshot = () =>
            cb(null, JSON.stringify({ success: true, data: { snapshot: 'tree' } }), '')
        } else {
          cb(null, JSON.stringify({ success: true, data: null }), '')
        }
      }
    )
    const first = b.snapshot()
    await vi.waitFor(() => expect(completeSnapshot).toBeTypeOf('function'))
    const second = b.snapshot()
    const refused = expect(second).rejects.toMatchObject({
      code: 'browser_client_page_automation_guest_not_ready'
    })
    current = false
    completeSnapshot()
    await first
    await refused
    expect(acquire).toHaveBeenCalledOnce()
    expect(execFileMock.mock.calls.filter((call) => call[1].includes('snapshot'))).toHaveLength(1)
  })
})
