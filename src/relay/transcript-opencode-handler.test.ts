import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MethodHandler, RelayDispatcher } from './dispatcher'

const readPage = vi.hoisted(() => vi.fn())
vi.mock('../main/native-chat/opencode-transcript-page', () => ({
  readOpenCodeTranscriptPage: readPage
}))
import { registerOpenCodeTranscriptHandler } from './transcript-opencode-handler'

let handler: MethodHandler
beforeEach(() => {
  readPage.mockReset()
  const onRequest = vi.fn((method: string, callback: MethodHandler) => {
    expect(method).toBe('transcript.readOpenCodePage')
    handler = callback
  })
  registerOpenCodeTranscriptHandler({ onRequest } as unknown as RelayDispatcher)
  expect(onRequest).toHaveBeenCalledTimes(1)
})

const request = { agent: 'opencode', sessionId: 'ses_one', transcriptPath: '/host/opencode.db' }
const context = { clientId: 1, isStale: () => false }

describe('OpenCode transcript relay request', () => {
  it('invokes only the owning-host reader and bounds shared control-lane responses', async () => {
    const result = { source: { connectionId: null }, sourceRecords: [] }
    readPage.mockResolvedValue(result)
    const signal = new AbortController().signal
    expect(await handler(request, { ...context, signal })).toBe(result)
    expect(readPage).toHaveBeenCalledWith(request, signal, { maxPayloadBytes: 256 * 1024 })
  })

  it.each([
    { ...request, sql: 'SELECT * FROM credentials' },
    { ...request, connectionId: 'different-host' },
    { ...request, agent: 'codex' },
    { ...request, sessionId: '../../secrets' },
    { ...request, limit: 0 },
    { ...request, limit: 201 }
  ])('rejects malformed or non-fixed reader requests before accessing storage', async (invalid) => {
    await expect(handler(invalid, context)).rejects.toThrow()
    expect(readPage).not.toHaveBeenCalled()
  })

  it('fences stale connections before storage access and after asynchronous capture', async () => {
    await expect(handler(request, { ...context, isStale: () => true })).rejects.toThrow(
      'connection changed'
    )
    expect(readPage).not.toHaveBeenCalled()
    let stale = false
    readPage.mockImplementation(async () => {
      stale = true
      return { sourceRecords: [] }
    })
    await expect(handler(request, { ...context, isStale: () => stale })).rejects.toThrow(
      'connection changed'
    )
  })

  it('rejects a cursor from another owning host', async () => {
    const cursor = {
      filePath: '/tmp/capture/source.jsonl',
      byteOffset: 0,
      snapshotSize: 1,
      fileIdentity: 'inode',
      sourceEpoch: 'epoch',
      observedSize: 1,
      observedMtime: 1,
      connectionId: 'other-host',
      agent: 'opencode',
      sessionId: 'ses_one'
    }
    await expect(handler({ ...request, cursor }, context)).rejects.toThrow()
    expect(readPage).not.toHaveBeenCalled()
  })
})
