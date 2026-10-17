/**
 * Hidden-output recovery must answer from RESTORED state, never from a partial model.
 *
 * A pty is marked provider-preferred when bytes may have crossed the sockets around attach, so
 * the headless model holds only a suffix of the session. `serializeTerminalBufferFromAvailableState`
 * always honoured that; hidden-output recovery did not, and it asks with `includeEmpty`, which
 * makes even a bare model answer. The user-visible result: after a restart, revealing a hidden tab
 * running a full-screen program restored it on the NORMAL buffer, so the program's repaints went
 * into scrollback (upstream 4ba8ddce48, which this ports).
 */
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './omni-runtime'
import type { PtyProviderBufferSnapshot } from '../providers/types'
import type { RuntimeTerminalRead } from '../../shared/runtime-terminal-contracts'
import { readScreenEvidence } from './terminal-agent-evidence'

const store = {
  getRepo: () => undefined,
  getRepos: () => [],
  addRepo: () => {},
  updateRepo: () => undefined as never,
  getAllWorktreeMeta: () => ({}),
  getWorktreeMeta: () => undefined,
  setWorktreeMeta: () => undefined as never,
  removeWorktreeMeta: () => {},
  getRetiredWorktreeNameRegistry: () => ({ exhaustedTiers: 0, names: [] }),
  addRetiredWorktreeName: () => {},
  mergeRetiredWorktreeNames: () => false,
  getGitHubCache: () => ({ pr: {}, issue: {} }) as never,
  getSettings: () => ({
    workspaceDir: '/tmp/workspaces',
    nestWorkspaces: false,
    refreshLocalBaseRefOnWorktreeCreate: false,
    branchPrefix: 'none',
    branchPrefixCustom: '',
    terminalMainSideEffectAuthority: true
  })
}

const PTY_ID = 'pty-hidden-output-preferred'
const RECAP_FRAME =
  '\x1b[?1049h\x1b[2;1H\x1b[2;3m  ↳ \x1b[1mRecap:\x1b[22;2m The result is retained.\x1b[0m\x1b[5;1HReady'
const EMPTY_READ: RuntimeTerminalRead = {
  handle: 'term',
  status: 'running',
  tail: [],
  truncated: false,
  nextCursor: null
}
const screenReader = (runtime: OrcaRuntimeService) =>
  runtime as unknown as {
    readRenderedScreen(
      ptyId: string,
      read: RuntimeTerminalRead,
      opts?: { limit?: number }
    ): Promise<RuntimeTerminalRead>
  }

/** The restored buffer a provider holds: the program is on the alternate screen. */
const RESTORED = {
  data: 'RESTORED-ALTERNATE',
  cols: 80,
  rows: 24,
  alternateScreen: true,
  source: 'renderer' as const
}

function createRuntime(
  overrides: Partial<NonNullable<Parameters<OrcaRuntimeService['setPtyController']>[0]>> = {}
): OrcaRuntimeService {
  const runtime = new OrcaRuntimeService(store)
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    getSize: () => ({ cols: 80, rows: 24 }),
    resize: () => true,
    ...overrides
  })
  return runtime
}

/** Marks the pty preferred the way attach does, without reaching into the field by name. */
function markPreferred(runtime: OrcaRuntimeService): void {
  ;(
    runtime as unknown as { providerSnapshotPreferredPtys: Set<string> }
  ).providerSnapshotPreferredPtys.add(PTY_ID)
}

describe('hidden-output recovery on a provider-preferred pty', () => {
  it('retains current screen evidence through a public read before a background PTY has a main model', async () => {
    const frame = [
      '\x1b[?1049h\x1b[2;1H• ACK',
      '\x1b[4;1H3:00 PM',
      '\x1b[6;1H\x1b[2;3m  ↳ \x1b[1mRecap:\x1b[22;2m The checks finished.\x1b[0m',
      '\x1b[7;1H\x1b[2;3m           The result is retained.\x1b[0m',
      '\x1b[9;1HTip: Use /help.',
      '\x1b[11;1H\x1b[1m›\x1b[0;2m Ask Codex to do anything',
      '\x1b[13;1Hgpt-6-astra medium · ~/workspace\x1b[0m\x1b[11;3H'
    ].join('')
    const provider = vi.fn(async () => ({
      data: frame,
      scrollbackAnsi: 'OLD HISTORY\r\n',
      cols: 256,
      rows: 78,
      seq: frame.length,
      source: 'headless' as const,
      alternateScreen: true
    }))
    let size: { cols: number; rows: number } | null = null
    const runtime = createRuntime({ getSize: () => size, serializeProviderBuffer: provider })
    const worktreeId = 'folder:background-screen'
    const tabId = 'background-tab'
    const leafId = '00000000-0000-4000-8000-000000000001'
    runtime.registerPty(PTY_ID, worktreeId, null, { tabId, leafId })
    runtime.seedTerminalRestoreTail(PTY_ID, { text: 'RESTORED TAIL\r\n' })
    const { handle } = runtime.resolveTerminalPane(`${tabId}:${leafId}`, worktreeId)
    expect(runtime.hasHeadlessTerminalState(PTY_ID)).toBe(false)

    const read = await runtime.readTerminal(handle, { screen: true })
    expect(provider).toHaveBeenCalledWith(PTY_ID, { scrollbackRows: 0 })
    expect(read).toMatchObject({
      source: 'screen',
      screenDecorations: [{ kind: 'codex-recap', startRow: 2, endRow: 3 }]
    })
    expect(read.tail).not.toContain('OLD HISTORY')
    expect(
      readScreenEvidence(
        read.tail,
        { blockedReason: () => null, readyPrompt: () => false },
        'ACK',
        read.screenDecorations
      )
    ).toMatchObject({ readyPrompt: true, turnDone: true, working: false })
    expect(runtime.hasHeadlessTerminalState(PTY_ID)).toBe(false)
    expect((await runtime.readTerminal(handle, { cursor: 0 })).tail).toContain('RESTORED TAIL')
    expect(
      (await runtime.readTerminal(handle, { screen: true, limit: 1 })).screenDecorations
    ).toBeUndefined()

    size = { cols: 120, rows: 40 }
    expect((await runtime.readTerminal(handle, { screen: true })).screenDecorations).toBeUndefined()
  })

  it('rejects a provider-only screen after its lifecycle changes during capture', async () => {
    let resolveSnapshot!: (snapshot: PtyProviderBufferSnapshot) => void
    let captureStarted!: () => void
    const started = new Promise<void>((resolve) => {
      captureStarted = resolve
    })
    const runtime = createRuntime({
      getSize: () => null,
      serializeProviderBuffer: () =>
        new Promise((resolve) => {
          resolveSnapshot = resolve
          captureStarted()
        })
    })
    const pending = screenReader(runtime).readRenderedScreen(PTY_ID, EMPTY_READ)
    await started
    runtime.onPtyExit(PTY_ID, 0)
    resolveSnapshot({ data: RECAP_FRAME, cols: 256, rows: 78, seq: 10, source: 'headless' })
    expect(await pending).toMatchObject({
      source: 'screen-unavailable',
      screenDecorations: undefined
    })
  })

  it('rejects a provider-only screen overtaken by newer output', async () => {
    let resolveSnapshot!: (snapshot: PtyProviderBufferSnapshot) => void
    let captureStarted!: () => void
    const started = new Promise<void>((resolve) => {
      captureStarted = resolve
    })
    const runtime = createRuntime({
      getSize: () => null,
      serializeProviderBuffer: () =>
        new Promise((resolve) => {
          resolveSnapshot = resolve
          captureStarted()
        })
    })
    const pending = screenReader(runtime).readRenderedScreen(PTY_ID, EMPTY_READ)
    await started
    runtime.onPtyData(PTY_ID, 'NEWER OUTPUT', 1)
    resolveSnapshot({ data: RECAP_FRAME, cols: 256, rows: 78, seq: 1, source: 'headless' })
    expect(await pending).toMatchObject({
      source: 'screen-unavailable',
      screenDecorations: undefined
    })
  })

  it('keeps recap evidence bound to canonical geometry even when the transient size cache is empty', async () => {
    let size: { cols: number; rows: number } | null = null
    const runtime = createRuntime({
      getSize: () => size,
      serializeProviderBuffer: async () => ({
        data: RECAP_FRAME,
        cols: 256,
        rows: 78,
        seq: RECAP_FRAME.length,
        source: 'headless',
        alternateScreen: true
      })
    })
    runtime.onPtyData(PTY_ID, RECAP_FRAME, 1)
    const first = await screenReader(runtime).readRenderedScreen(PTY_ID, EMPTY_READ)
    expect(first.screenDecorations).toEqual([{ kind: 'codex-recap', startRow: 0, endRow: 0 }])
    expect((await runtime.serializeMainTerminalBuffer(PTY_ID))?.cols).toBe(256)
    size = { cols: 120, rows: 40 }
    const changed = await screenReader(runtime).readRenderedScreen(PTY_ID, EMPTY_READ)
    expect(changed.tail).toEqual(first.tail)
    expect(changed.screenDecorations).toBeUndefined()
  })

  it('drops recap evidence on clipped screen reads and never inherits evidence from a prior tail', async () => {
    const runtime = createRuntime()
    runtime.onPtyData(PTY_ID, RECAP_FRAME, 1)
    const first = await screenReader(runtime).readRenderedScreen(PTY_ID, EMPTY_READ)
    expect(first.screenDecorations).toHaveLength(1)
    const clipped = await screenReader(runtime).readRenderedScreen(PTY_ID, first, { limit: 1 })
    expect(clipped.screenDecorations).toBeUndefined()
    runtime.onPtyData(PTY_ID, '\x1b[2J\x1b[Hplain output', 2)
    expect(
      (await screenReader(runtime).readRenderedScreen(PTY_ID, first)).screenDecorations
    ).toBeUndefined()
    const large = createRuntime({ getSize: () => ({ cols: 512, rows: 100 }) })
    const dense = Array.from(
      { length: 80 },
      (_, row) => `\x1b[${row + 6};1H${'x'.repeat(500)}`
    ).join('')
    large.onPtyData(PTY_ID, RECAP_FRAME + dense, 1)
    const charClipped = await screenReader(large).readRenderedScreen(PTY_ID, EMPTY_READ, {
      limit: 100
    })
    expect(charClipped.limited).toBe(true)
    expect(charClipped.screenDecorations).toBeUndefined()
  })

  it('never publishes styled recap metadata from a prior generation', async () => {
    let resolveSnapshot!: (snapshot: PtyProviderBufferSnapshot) => void
    const provider = vi
      .fn<() => Promise<PtyProviderBufferSnapshot | null>>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSnapshot = resolve
          })
      )
      .mockResolvedValue(null)
    const runtime = createRuntime({ getSize: () => null, serializeProviderBuffer: provider })
    runtime.onPtyData(PTY_ID, RECAP_FRAME, 1)
    const pending = screenReader(runtime).readRenderedScreen(PTY_ID, EMPTY_READ)
    runtime.onPtyExit(PTY_ID, 0)
    resolveSnapshot({
      data: RECAP_FRAME,
      cols: 256,
      rows: 78,
      seq: RECAP_FRAME.length,
      source: 'headless',
      alternateScreen: true
    })
    expect((await pending).screenDecorations).toBeUndefined()
  })

  it('answers with the restored provider buffer, not the partial headless model', async () => {
    const runtime = createRuntime()
    const provider = vi
      .spyOn(
        runtime as unknown as { serializeProviderTerminalBuffer: () => Promise<unknown> },
        'serializeProviderTerminalBuffer'
      )
      .mockResolvedValue(RESTORED)
    // A live byte lazily creates a bare model; with includeEmpty it would otherwise win.
    runtime.onPtyData(PTY_ID, 'LIVE-SUFFIX\r\n', 1)
    markPreferred(runtime)

    const snapshot = await runtime.serializeHiddenOutputRecoveryBuffer(PTY_ID)

    expect(provider).toHaveBeenCalled()
    expect(snapshot?.data).toBe('RESTORED-ALTERNATE')
    expect(snapshot?.alternateScreen).toBe(true)
  })

  it('falls back to the renderer when the provider cannot answer', async () => {
    const runtime = createRuntime()
    vi.spyOn(
      runtime as unknown as { serializeProviderTerminalBuffer: () => Promise<unknown> },
      'serializeProviderTerminalBuffer'
    ).mockResolvedValue(null)
    const renderer = vi
      .spyOn(runtime, 'serializeRendererTerminalBuffer')
      .mockResolvedValue(RESTORED as never)
    runtime.onPtyData(PTY_ID, 'LIVE-SUFFIX\r\n', 1)
    markPreferred(runtime)

    const snapshot = await runtime.serializeHiddenOutputRecoveryBuffer(PTY_ID)

    expect(renderer).toHaveBeenCalled()
    expect(snapshot?.alternateScreen).toBe(true)
  })

  it('still answers from the headless model when the pty is not preferred', async () => {
    const runtime = createRuntime()
    const provider = vi.spyOn(
      runtime as unknown as { serializeProviderTerminalBuffer: () => Promise<unknown> },
      'serializeProviderTerminalBuffer'
    )
    runtime.onPtyData(PTY_ID, 'ORDINARY-OUTPUT\r\n', 1)

    const snapshot = await runtime.serializeHiddenOutputRecoveryBuffer(PTY_ID)

    expect(snapshot?.data).toContain('ORDINARY-OUTPUT')
    expect(provider).not.toHaveBeenCalled()
  })

  it('rebuilds a background fallback grid from the owner frame without resizing the PTY', async () => {
    const frame = '\x1b[?1049h\x1b[60;200HREADY\x1b[79;1H› '
    const resize = vi.fn(() => true)
    const write = vi.fn(() => true)
    const provider = vi.fn(async () => ({
      data: frame,
      cols: 256,
      rows: 79,
      seq: frame.length,
      source: 'headless' as const,
      lastTitle: 'Retained owner title',
      alternateScreen: true
    }))
    const runtime = createRuntime({
      getSize: () => null,
      serializeProviderBuffer: provider,
      resize,
      write
    })
    runtime.onPtyData(PTY_ID, frame, 1)

    // The 80×24 fallback has already clipped these cursor-addressed cells.
    expect(await runtime.serializeMainTerminalBuffer(PTY_ID)).toBeNull()
    const recovered = await runtime.serializeHiddenOutputRecoveryBuffer(PTY_ID)
    const main = await runtime.serializeMainTerminalBuffer(PTY_ID)

    expect(recovered).toMatchObject({ cols: 256, rows: 79, alternateScreen: true })
    expect(main).toMatchObject({
      cols: 256,
      rows: 79,
      alternateScreen: true,
      source: 'headless',
      seq: frame.length,
      lastTitle: 'Retained owner title'
    })
    expect(main?.data).toContain('READY')
    expect(provider).toHaveBeenCalledOnce()
    expect(resize).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()

    runtime.onPtyData(PTY_ID, '\x1b[79;3HNEXT', 2)
    expect((await runtime.serializeMainTerminalBuffer(PTY_ID))?.data).toContain('NEXT')
  })

  it('never promotes a fallback model when the provider cannot supply its frame', async () => {
    const runtime = createRuntime({
      getSize: () => null,
      serializeProviderBuffer: async () => null,
      hasRendererSerializer: () => false
    })
    runtime.onPtyData(PTY_ID, 'UNCONFIRMED', 1)

    expect(await runtime.serializeHiddenOutputRecoveryBuffer(PTY_ID)).toBeNull()
    expect(await runtime.serializeMainTerminalBuffer(PTY_ID)).toBeNull()
  })

  it('does not replace newer streamed output with a delayed owner frame', async () => {
    const oldFrame = '\x1b[?1049hOLD FRAME'
    let resolveSnapshot!: (snapshot: PtyProviderBufferSnapshot) => void
    const runtime = createRuntime({
      getSize: () => null,
      serializeProviderBuffer: () =>
        new Promise((resolve) => {
          resolveSnapshot = resolve
        })
    })
    runtime.onPtyData(PTY_ID, oldFrame, 1)
    const recovery = runtime.serializeHiddenOutputRecoveryBuffer(PTY_ID)
    runtime.onPtyData(PTY_ID, '\x1b[79;1HNEWER FRAME', 2)
    resolveSnapshot({
      data: oldFrame,
      cols: 256,
      rows: 79,
      seq: oldFrame.length,
      alternateScreen: true,
      source: 'headless'
    })
    await recovery

    expect(await runtime.serializeMainTerminalBuffer(PTY_ID)).toBeNull()
  })

  it('does not adopt an owner frame ahead of the received stream boundary', async () => {
    const frame = '\x1b[?1049hOWNER FRAME'
    const runtime = createRuntime({
      getSize: () => null,
      serializeProviderBuffer: async () => ({
        data: frame,
        cols: 256,
        rows: 79,
        seq: frame.length + 50,
        alternateScreen: true,
        source: 'headless'
      })
    })
    runtime.onPtyData(PTY_ID, frame, 1)

    expect(await runtime.serializeHiddenOutputRecoveryBuffer(PTY_ID)).toMatchObject({
      cols: 256,
      rows: 79
    })
    expect(await runtime.serializeMainTerminalBuffer(PTY_ID)).toBeNull()
  })

  it('does not revive a prior PTY generation from a delayed owner frame', async () => {
    const frame = '\x1b[?1049hOLD GENERATION'
    let resolveSnapshot!: (snapshot: PtyProviderBufferSnapshot) => void
    const runtime = createRuntime({
      getSize: () => null,
      serializeProviderBuffer: vi
        .fn<() => Promise<PtyProviderBufferSnapshot | null>>()
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveSnapshot = resolve
            })
        )
        .mockResolvedValue(null),
      hasRendererSerializer: () => false
    })
    runtime.onPtyData(PTY_ID, frame, 1)
    const recovery = runtime.serializeHiddenOutputRecoveryBuffer(PTY_ID)
    runtime.onPtyExit(PTY_ID, 0)
    resolveSnapshot({
      data: frame,
      cols: 256,
      rows: 79,
      seq: frame.length,
      alternateScreen: true,
      source: 'headless'
    })

    expect(await recovery).toBeNull()
    expect(await runtime.serializeMainTerminalBuffer(PTY_ID)).toBeNull()
  })

  it('does not overwrite a geometry change that arrived while the owner snapshot was pending', async () => {
    const frame = '\x1b[?1049hBEFORE RESIZE'
    let size: { cols: number; rows: number } | null = null
    let resolveSnapshot!: (snapshot: PtyProviderBufferSnapshot) => void
    const runtime = createRuntime({
      getSize: () => size,
      serializeProviderBuffer: () =>
        new Promise((resolve) => {
          resolveSnapshot = resolve
        })
    })
    runtime.onPtyData(PTY_ID, frame, 1)
    const recovery = runtime.serializeHiddenOutputRecoveryBuffer(PTY_ID)
    size = { cols: 120, rows: 40 }
    runtime.onExternalPtyResize(PTY_ID, size.cols, size.rows)
    resolveSnapshot({
      data: frame,
      cols: 256,
      rows: 79,
      seq: frame.length,
      alternateScreen: true,
      source: 'headless'
    })
    await recovery

    expect(await runtime.serializeMainTerminalBuffer(PTY_ID)).toBeNull()
  })
})
