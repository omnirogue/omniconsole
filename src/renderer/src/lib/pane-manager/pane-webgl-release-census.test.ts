import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPaneInternal, PaneRenderingDiagnostics } from './pane-manager-types'
import {
  getLivePaneCensus,
  getTerminalResourceCounts,
  recordTerminalWebglContextRelease,
  registerLivePaneManager,
  unregisterLivePaneManager
} from './pane-manager-registry'
import { attachWebgl, disposeWebgl, resetTerminalWebglSuggestion } from './pane-webgl-renderer'
import { disposePane } from './pane-lifecycle'

type FakeManager = {
  resetWebglTextureAtlases: () => void
  getPaneCount?: () => number
  getRenderingDiagnostics?: () => PaneRenderingDiagnostics[]
  isVisibleForAtlasRecovery?: () => boolean
}

function diagnostics(hasWebgl: boolean[]): PaneRenderingDiagnostics[] {
  return hasWebgl.map((webgl, index) => ({ paneId: index + 1, hasWebgl: webgl }) as never)
}

function createPane(): ManagedPaneInternal {
  const leafId = '44444444-4444-4444-8444-444444444444' as never
  return {
    id: 1,
    leafId,
    stablePaneId: leafId,
    terminal: {
      cols: 80,
      rows: 24,
      refresh: vi.fn(),
      loadAddon: vi.fn(),
      dispose: vi.fn()
    } as never,
    container: {} as never,
    xtermContainer: {} as never,
    linkTooltip: {} as never,
    terminalGpuAcceleration: 'on',
    gpuRenderingEnabled: true,
    webglAttachmentDeferred: false,
    webglDisabledAfterContextLoss: false,
    hasComplexScriptOutput: false,
    webglAddon: null,
    ligaturesAddon: null,
    fitResizeObserver: null,
    pendingObservedFitRafId: null,
    pendingWebglRefreshRafId: null,
    fitAddon: { proposeDimensions: vi.fn(() => ({ cols: 80, rows: 23 })), fit: vi.fn() } as never,
    searchAddon: {} as never,
    serializeAddon: {} as never,
    unicode11Addon: {} as never,
    webLinksAddon: {} as never,
    compositionHandler: null,
    pendingSplitScrollState: null,
    debugLabel: null
  }
}

type FakeWebglAddon = {
  dispose: ReturnType<typeof vi.fn>
  loseContext: ReturnType<typeof vi.fn>
  canvas: { width: number; height: number }
}

function attachFakeWebglAddon(
  pane: ManagedPaneInternal,
  options: { disposeThrows?: boolean } = {}
): FakeWebglAddon {
  const loseContext = vi.fn()
  const canvas = { width: 1600, height: 900 }
  const dispose = vi.fn(() => {
    if (options.disposeThrows) {
      throw new Error('already disposed')
    }
  })
  pane.webglAddon = {
    dispose,
    _renderer: {
      _gl: { getExtension: () => ({ loseContext }) },
      _canvas: canvas
    }
  } as never
  return { dispose, loseContext, canvas }
}

describe('live pane census WebGL accounting', () => {
  const registered: FakeManager[] = []

  function register(manager: FakeManager): FakeManager {
    registerLivePaneManager(manager)
    registered.push(manager)
    return manager
  }

  afterEach(() => {
    for (const manager of registered.splice(0)) {
      unregisterLivePaneManager(manager)
    }
  })

  it('reports zero WebGL contexts when nothing is mounted', () => {
    expect(getLivePaneCensus()).toMatchObject({
      managers: 0,
      panes: 0,
      webglContexts: 0,
      hiddenWebglContexts: 0
    })
  })

  it('counts WebGL contexts across visible managers', () => {
    register({
      resetWebglTextureAtlases: vi.fn(),
      getPaneCount: () => 3,
      getRenderingDiagnostics: () => diagnostics([true, false, true]),
      isVisibleForAtlasRecovery: () => true
    })

    expect(getLivePaneCensus()).toMatchObject({
      managers: 1,
      panes: 3,
      webglContexts: 2,
      hiddenWebglContexts: 0
    })
  })

  it('attributes contexts still held by hidden (warm) managers', () => {
    register({
      resetWebglTextureAtlases: vi.fn(),
      getPaneCount: () => 1,
      getRenderingDiagnostics: () => diagnostics([true]),
      isVisibleForAtlasRecovery: () => true
    })
    register({
      resetWebglTextureAtlases: vi.fn(),
      getPaneCount: () => 2,
      getRenderingDiagnostics: () => diagnostics([true, true]),
      isVisibleForAtlasRecovery: () => false
    })

    expect(getLivePaneCensus()).toMatchObject({
      managers: 2,
      panes: 3,
      webglContexts: 3,
      hiddenWebglContexts: 2
    })
  })

  it('treats a manager without a visibility probe as visible', () => {
    register({
      resetWebglTextureAtlases: vi.fn(),
      getPaneCount: () => 1,
      getRenderingDiagnostics: () => diagnostics([true])
    })

    expect(getLivePaneCensus()).toMatchObject({ webglContexts: 1, hiddenWebglContexts: 0 })
  })

  it('counts panes for managers that cannot report rendering diagnostics', () => {
    register({ resetWebglTextureAtlases: vi.fn(), getPaneCount: () => 4 })

    expect(getLivePaneCensus()).toMatchObject({ panes: 4, webglContexts: 0 })
  })

  it('keeps counting other managers when one throws mid-teardown', () => {
    register({
      resetWebglTextureAtlases: vi.fn(),
      getPaneCount: () => 1,
      getRenderingDiagnostics: () => {
        throw new Error('disposed')
      }
    })
    register({
      resetWebglTextureAtlases: vi.fn(),
      getPaneCount: () => 1,
      getRenderingDiagnostics: () => diagnostics([true]),
      isVisibleForAtlasRecovery: () => false
    })

    expect(getLivePaneCensus()).toMatchObject({
      managers: 2,
      panes: 2,
      webglContexts: 1,
      hiddenWebglContexts: 1
    })
  })

  it('drops a parked manager’s contexts from the census once it unregisters', () => {
    const hidden = register({
      resetWebglTextureAtlases: vi.fn(),
      getPaneCount: () => 2,
      getRenderingDiagnostics: () => diagnostics([true, true]),
      isVisibleForAtlasRecovery: () => false
    })
    expect(getLivePaneCensus().hiddenWebglContexts).toBe(2)

    unregisterLivePaneManager(hidden)

    expect(getLivePaneCensus()).toMatchObject({
      managers: 0,
      webglContexts: 0,
      hiddenWebglContexts: 0
    })
  })

  it('feeds getTerminalResourceCounts from the same census', () => {
    register({
      resetWebglTextureAtlases: vi.fn(),
      getPaneCount: () => 2,
      getRenderingDiagnostics: () => diagnostics([true, false])
    })
    const census = getLivePaneCensus()

    expect(getTerminalResourceCounts()).toEqual({
      xterms: census.panes,
      webglContexts: census.webglContexts
    })
  })

  it('reports a monotonic released-context counter', () => {
    const before = getLivePaneCensus().webglContextsReleased
    recordTerminalWebglContextRelease()
    recordTerminalWebglContextRelease()

    expect(getLivePaneCensus().webglContextsReleased).toBe(before + 2)
  })
})

describe('WebGL context release on pane teardown', () => {
  beforeEach(() => {
    resetTerminalWebglSuggestion()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('loses the GL context, zeroes the canvas and counts one release', () => {
    const pane = createPane()
    const addon = attachFakeWebglAddon(pane)
    const before = getLivePaneCensus().webglContextsReleased

    disposeWebgl(pane)

    expect(addon.loseContext).toHaveBeenCalledTimes(1)
    expect(addon.canvas).toEqual({ width: 0, height: 0 })
    expect(addon.dispose).toHaveBeenCalledTimes(1)
    expect(pane.webglAddon).toBeNull()
    expect(getLivePaneCensus().webglContextsReleased).toBe(before + 1)
  })

  it('does not count a release for a DOM-rendered pane', () => {
    const pane = createPane()
    const before = getLivePaneCensus().webglContextsReleased

    disposeWebgl(pane)

    expect(getLivePaneCensus().webglContextsReleased).toBe(before)
  })

  it('counts a release only once when teardown runs twice', () => {
    const pane = createPane()
    attachFakeWebglAddon(pane)
    const before = getLivePaneCensus().webglContextsReleased

    disposeWebgl(pane)
    disposeWebgl(pane)

    expect(getLivePaneCensus().webglContextsReleased).toBe(before + 1)
  })

  it('still counts the release when the addon throws on dispose', () => {
    const pane = createPane()
    const addon = attachFakeWebglAddon(pane, { disposeThrows: true })
    const before = getLivePaneCensus().webglContextsReleased

    disposeWebgl(pane)

    expect(addon.loseContext).toHaveBeenCalled()
    expect(pane.webglAddon).toBeNull()
    expect(getLivePaneCensus().webglContextsReleased).toBe(before + 1)
  })

  it('counts the release when a parked pane is disposed through the pane lifecycle', () => {
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const pane = createPane()
    const addon = attachFakeWebglAddon(pane)
    const before = getLivePaneCensus().webglContextsReleased

    disposePane(pane, new Map([[pane.id, pane]]))

    expect(addon.loseContext).toHaveBeenCalledTimes(1)
    expect(getLivePaneCensus().webglContextsReleased).toBe(before + 1)
  })

  it('counts a release for a real attached WebGL addon', () => {
    const pane = createPane()
    attachWebgl(pane)
    expect(pane.webglAddon).not.toBeNull()
    const before = getLivePaneCensus().webglContextsReleased

    disposeWebgl(pane)

    expect(pane.webglAddon).toBeNull()
    expect(getLivePaneCensus().webglContextsReleased).toBe(before + 1)
  })
})
