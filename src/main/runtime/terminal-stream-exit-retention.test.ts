import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './omni-runtime'
import { createBoundedTerminalStream } from '../../shared/terminal-stream'

describe('terminal stream retention at physical exit', () => {
  const ptyId = 'pty-stream-exit'
  const incarnationId = 'stream-incarnation'
  const handle = 'term_stream_exit'
  let runtime: OrcaRuntimeService

  beforeEach(() => {
    vi.useFakeTimers()
    runtime = new OrcaRuntimeService(null)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.registerPty(ptyId, 'folder:stream-exit', null, {
      incarnationId,
      tabId: 'stream-tab',
      leafId: 'stream-leaf'
    })
    runtime.registerPreAllocatedHandleForPty(ptyId, handle)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'stream-tab',
          worktreeId: 'folder:stream-exit',
          title: 'Stream',
          activeLeafId: 'stream-leaf',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'stream-tab',
          worktreeId: 'folder:stream-exit',
          leafId: 'stream-leaf',
          paneRuntimeId: 1,
          ptyId
        }
      ]
    })
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('preserves a live cursor and returns the final committed line after disposal', async () => {
    runtime.onPtyData(ptyId, 'first\nsecond\n', 100)
    const before = await runtime.readTerminal(handle, { cursor: 0 })
    expect(before.nextCursor).toBe('2')
    runtime.onPtyData(ptyId, 'verifier final\n', 101)
    runtime.onPtyExit(ptyId, 0, incarnationId, {
      providerExitObserved: true,
      cause: { kind: 'exited', exitCode: 0 }
    })
    await expect(runtime.readTerminal(handle, { cursor: 2 })).resolves.toMatchObject({
      status: 'exited',
      tail: ['verifier final'],
      nextCursor: '3',
      latestCursor: '3'
    })
    await expect(runtime.readTerminal(handle, { cursor: 3 })).resolves.toMatchObject({
      tail: [],
      nextCursor: '3',
      latestCursor: '3'
    })
  })

  it.each(['{"result":"passed"}', '{"result":"passed"}\x1b['])(
    'commits unterminated final output once: %j',
    async (final) => {
      const stream = createBoundedTerminalStream()
      const chunks = ['first\nsecond\n', final]
      for (const chunk of chunks) {
        runtime.onPtyData(ptyId, chunk, 100)
        stream.append(chunk)
      }
      runtime.onPtyExit(ptyId, 0, incarnationId, {
        providerExitObserved: true,
        cause: { kind: 'exited', exitCode: 0 }
      })
      runtime.onPtyExit(ptyId, 0, incarnationId, {
        providerExitObserved: true,
        cause: { kind: 'exited', exitCode: 0 }
      })
      stream.finish()
      const snapshot = stream.snapshot()
      await expect(runtime.readTerminal(handle, { cursor: 0 })).resolves.toMatchObject({
        tail: snapshot.lines,
        nextCursor: String(snapshot.completedLineCount),
        latestCursor: '3'
      })
      await expect(runtime.readTerminal(handle, { cursor: 2 })).resolves.toMatchObject({
        tail: ['{"result":"passed"}']
      })
    }
  )

  it.each([
    undefined,
    {
      providerExitObserved: true,
      cause: { kind: 'unknown' as const, reason: 'stop_unverified' as const }
    }
  ])('does not commit EOF from an uncertain exit: %j', async (options) => {
    runtime.onPtyData(ptyId, 'complete\npartial', 100)
    runtime.onPtyExit(ptyId, options ? -1 : 0, incarnationId, options)
    await expect(runtime.readTerminal(handle, { cursor: 1 })).resolves.toMatchObject({
      tail: [],
      nextCursor: '1',
      latestCursor: '1'
    })
  })

  it('does not commit EOF for a different process incarnation', async () => {
    runtime.onPtyData(ptyId, 'complete\npartial', 100)
    runtime.onPtyExit(ptyId, 0, 'old-incarnation', { providerExitObserved: true })
    await expect(runtime.readTerminal(handle, { cursor: 1 })).resolves.toMatchObject({
      status: 'running',
      tail: [],
      nextCursor: '1'
    })
  })
})
