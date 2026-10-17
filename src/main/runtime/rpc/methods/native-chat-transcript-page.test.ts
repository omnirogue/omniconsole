import { describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../core'

const readPage = vi.hoisted(() => vi.fn())
vi.mock('../../../native-chat/transcript-page-reader', () => ({
  readNativeChatTranscriptPage: readPage,
  MAX_TRANSCRIPT_PAGE_RECORDS: 200
}))

const { NATIVE_CHAT_TRANSCRIPT_PAGE_METHOD: method } = await import('./native-chat-transcript-page')

describe('nativeChat.readTranscriptPage wire boundary', () => {
  it('uses a distinct method so older hosts cannot strip source-host routing', () => {
    expect(method.name).toBe('nativeChat.readTranscriptPage')
    expect(
      method.params!.parse({
        agent: 'codex',
        sessionId: 'remote-session',
        connectionId: 'ssh-owner',
        limit: 200
      })
    ).toMatchObject({ connectionId: 'ssh-owner' })
  })

  it('preserves the owning-host acknowledgement, full records and refusal counters for mobile callers', async () => {
    const record = JSON.stringify({ role: 'user', text: 'x'.repeat(70_000) })
    const result = {
      source: { connectionId: 'ssh-owner' },
      messages: [],
      sourceRecords: [{ byteOffset: 0, text: record }],
      complete: true,
      malformedRecordCount: 2,
      oversizedRecordCount: 1,
      truncatedRecordCount: 3
    }
    readPage.mockResolvedValueOnce(result)
    const controller = new AbortController()
    const params = method.params!.parse({
      agent: 'codex',
      sessionId: 'remote-session',
      connectionId: 'ssh-owner',
      transcriptPath: '/remote/rollout.jsonl'
    })
    const actual = await method.handler(params, {
      runtime: {} as RpcContext['runtime'],
      connectionId: 'paired-client-transport',
      clientKind: 'mobile',
      signal: controller.signal
    })
    expect(actual).toEqual(result)
    expect(readPage).toHaveBeenLastCalledWith(params, controller.signal)
  })

  it('rejects unsafe offsets and excessive per-page limits before any read', () => {
    const base = { agent: 'codex', sessionId: 'session' }
    expect(method.params!.safeParse({ ...base, limit: 201 }).success).toBe(false)
    expect(method.params!.safeParse({ ...base, connectionId: '' }).success).toBe(false)
    expect(
      method.params!.safeParse({
        ...base,
        cursor: {
          filePath: '/remote/rollout.jsonl',
          byteOffset: Number.MAX_SAFE_INTEGER + 1,
          snapshotSize: 100,
          fileIdentity: 'inode',
          sourceEpoch: 'epoch',
          observedSize: 100,
          observedMtime: null,
          connectionId: null,
          agent: 'codex',
          sessionId: 'session'
        }
      }).success
    ).toBe(false)
  })
})
