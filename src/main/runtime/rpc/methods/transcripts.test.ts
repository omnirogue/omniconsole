import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'

const read = vi.hoisted(() => vi.fn())
vi.mock('../../../native-chat/transcript-watch', () => ({ readNativeChatTranscriptTail: read }))

const { TRANSCRIPT_METHODS } = await import('./transcripts')
const method = TRANSCRIPT_METHODS[0]!

function said(text: string, id = 'm1'): NativeChatMessage {
  return {
    id,
    role: 'user',
    blocks: [{ type: 'text', text }],
    timestamp: Date.UTC(2026, 8, 13, 9, 0, 0),
    source: 'transcript'
  }
}

const params = {
  agent: 'claude',
  sessionId: 'ses_abc123',
  capturedAt: '2026-09-13T09:30:00.000Z',
  model: 'opus-5',
  expectedConnectionId: null as string | null
}

function call(overrides: Record<string, unknown> = {}) {
  return method.handler({ ...params, ...overrides }, {} as never) as Promise<
    Record<string, unknown>
  >
}

beforeEach(() => {
  read.mockReset()
})

describe('transcripts.buildDeliverable', () => {
  it('is named so an older host refuses it rather than ignoring it', () => {
    expect(method.name).toBe('transcripts.buildDeliverable')
  })

  it('returns the file with the digest of the bytes it built', async () => {
    read.mockResolvedValue({ messages: [said('Ship the thing.')], hasMore: false, beforeOffset: 0 })
    const result = await call()
    expect(result.name).toBe('transcript-ses_abc123-20260913.md')
    const bytes = Buffer.from(result.contentBase64 as string, 'base64')
    expect(result.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(result.size).toBe(bytes.byteLength)
    expect(result.messageCount).toBe(1)
    expect(result.earlierMessagesOmitted).toBe(false)
    expect(result.omittedRecords).toBe(0)
    expect(bytes.toString('utf8')).toContain('Ship the thing.')
    expect(bytes.toString('utf8')).toContain('- Model: opus-5')
  })

  it('refuses a session carrying a planted key, and returns no transcript', async () => {
    const key = `sk-ant-${'a'.repeat(50)}`
    read.mockResolvedValue({
      messages: [said(`the key is ${key}`)],
      hasMore: false,
      beforeOffset: 0
    })
    const result = await call()
    expect(result).toEqual({ reason: 'transcript_contains_protected_data', redactions: 1 })
    expect(result.contentBase64).toBeUndefined()
    expect(JSON.stringify(result)).not.toContain(key)
  })

  it('refuses a key that only appears in tool output', async () => {
    read.mockResolvedValue({
      messages: [
        {
          id: 'm1',
          role: 'tool',
          blocks: [{ type: 'tool-result', output: `GITHUB_TOKEN=ghp_${'c'.repeat(36)}` }],
          timestamp: Date.UTC(2026, 8, 13, 9, 0, 0),
          source: 'transcript'
        } satisfies NativeChatMessage
      ],
      hasMore: false,
      beforeOffset: 0
    })
    expect(await call()).toMatchObject({ reason: 'transcript_contains_protected_data' })
  })

  it('digests what the host read, never a digest the caller supplied', async () => {
    const messages = [said('Ship the thing.')]
    read.mockResolvedValue({ messages, hasMore: false, beforeOffset: 0 })
    const result = await call({ sourceDigest: 'f'.repeat(64) })
    const expected = createHash('sha256').update(JSON.stringify(messages)).digest('hex')
    const body = Buffer.from(result.contentBase64 as string, 'base64').toString('utf8')
    expect(body).toContain(`- Source digest: ${expected}`)
    expect(body).not.toContain('f'.repeat(64))
  })

  it('says plainly when only the session tail was read', async () => {
    read.mockResolvedValue({ messages: [said('later')], hasMore: true, beforeOffset: 10 })
    const result = await call()
    expect(result.earlierMessagesOmitted).toBe(true)
    const body = Buffer.from(result.contentBase64 as string, 'base64').toString('utf8')
    expect(body).toContain('earlier messages are not included')
  })

  it('never forwards a reader message, which names the transcript path', async () => {
    // The reviewer's case: a token-shaped directory inside an EACCES message.
    const leak =
      "EACCES: permission denied, open '/Users/x/.claude/projects/ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/ses_a.jsonl'"
    read.mockResolvedValue({ error: leak })
    const result = await call()
    expect(result).toEqual({ error: 'transcript_unavailable' })
    expect(JSON.stringify(result)).not.toContain('ghp_')
    expect(JSON.stringify(result)).not.toContain('.claude')
  })

  it('contains an exception thrown by the reader inside the boundary', async () => {
    read.mockRejectedValue(
      new Error("EACCES: permission denied, open '/Users/x/.claude/projects/ghp_SECRET/x.jsonl'")
    )
    const result = await call()
    expect(result).toEqual({ error: 'transcript_unavailable' })
    expect(JSON.stringify(result)).not.toContain('ghp_')
  })

  it('answers an oversized transcript with a code and a length, not a message', async () => {
    read.mockResolvedValue({
      messages: [said('z'.repeat(9 * 1024 * 1024))],
      hasMore: false,
      beforeOffset: 0
    })
    const result = await call()
    expect(result.error).toBe('transcript_too_large')
    expect(typeof result.sizeBytes).toBe('number')
  })

  it('refuses a session that lives behind an SSH connection', async () => {
    const result = await call({ expectedConnectionId: 'server-a' })
    expect(result).toEqual({ error: 'transcript_remote_host_unsupported' })
    // The local reader is never consulted for another machine's session.
    expect(read).not.toHaveBeenCalled()
  })

  it('refuses when the caller states no host identity at all', async () => {
    const result = await call({ expectedConnectionId: undefined })
    expect(result).toEqual({ error: 'transcript_remote_host_unsupported' })
    expect(read).not.toHaveBeenCalled()
  })

  it('discloses records the reader skipped rather than claiming completeness', async () => {
    // Short message, a 2 MiB record above the reader's limit, short message.
    read.mockResolvedValue({
      messages: [said('first', 'm1'), said('third', 'm3')],
      hasMore: false,
      beforeOffset: 0,
      oversizedRecordCount: 1
    })
    const result = await call()
    expect(result.omittedRecords).toBe(1)
    const body = Buffer.from(result.contentBase64 as string, 'base64').toString('utf8')
    expect(body).toContain('- Omitted records: 1')
    expect(body).toContain('not a continuous record of the session')
  })

  it('counts malformed and oversized records together', async () => {
    read.mockResolvedValue({
      messages: [said('kept')],
      hasMore: false,
      beforeOffset: 0,
      malformedRecordCount: 2,
      oversizedRecordCount: 1
    })
    expect((await call()).omittedRecords).toBe(3)
  })

  it('answers an empty session rather than building an empty transcript', async () => {
    read.mockResolvedValue({ messages: [], hasMore: false, beforeOffset: 0 })
    expect(await call()).toEqual({ error: 'transcript_empty' })
  })

  it('contains a serializer fault raised while hashing the source', async () => {
    // The source hash runs on messages the host read. A getter that throws
    // would otherwise escape the handler and reach the client as the
    // dispatcher's runtime_error, carrying whatever the message names.
    const hostile = said('hi')
    Object.defineProperty(hostile, 'turnId', {
      enumerable: true,
      get() {
        throw new Error("EACCES '/Users/x/.claude/projects/ghp_LEAKED/ses.jsonl'")
      }
    })
    read.mockResolvedValue({ messages: [hostile], hasMore: false, beforeOffset: 0 })
    const result = await call()
    expect(result).toEqual({ error: 'transcript_build_failed' })
    expect(JSON.stringify(result)).not.toContain('ghp_')
  })

  it('contains a circular message structure the same way', async () => {
    const circular = said('hi') as NativeChatMessage & { self?: unknown }
    circular.self = circular
    read.mockResolvedValue({ messages: [circular], hasMore: false, beforeOffset: 0 })
    expect(await call()).toEqual({ error: 'transcript_build_failed' })
  })

  it('refuses an oversized source before serializing or scanning it', async () => {
    // The reviewer's case: a 64 MiB payload reached ~430 MiB RSS because the
    // whole source was serialized for the hash and scanned for secrets before
    // anything checked its size.
    read.mockResolvedValue({
      messages: [said('z'.repeat(20 * 1024 * 1024))],
      hasMore: false,
      beforeOffset: 0
    })
    const started = performance.now()
    const result = await call()
    expect(result.error).toBe('transcript_too_large')
    expect(result.sizeBytes).toBeGreaterThan(16 * 1024 * 1024)
    // A bounded walk, not three passes over 20 MiB.
    expect(performance.now() - started).toBeLessThan(1000)
  })

  it('contains a throwing getter met while measuring a tool input', async () => {
    // The size walk enumerates properties, so it can throw where the serializer
    // would. It sits inside the same boundary for that reason.
    const hostile: Record<string, unknown> = {}
    Object.defineProperty(hostile, 'body', {
      enumerable: true,
      get() {
        throw new Error("EACCES '/Users/x/.claude/projects/ghp_LEAKED/ses.jsonl'")
      }
    })
    read.mockResolvedValue({
      messages: [
        {
          id: 'm1',
          role: 'assistant',
          blocks: [{ type: 'tool-call', name: 'write', input: hostile }],
          timestamp: Date.UTC(2026, 8, 13, 9, 0, 0),
          source: 'transcript'
        } satisfies NativeChatMessage
      ],
      hasMore: false,
      beforeOffset: 0
    })
    const result = await call()
    expect(result).toEqual({ error: 'transcript_build_failed' })
    expect(JSON.stringify(result)).not.toContain('ghp_')
  })

  it('still builds a source just inside the budget', async () => {
    read.mockResolvedValue({
      messages: [said('z'.repeat(1024))],
      hasMore: false,
      beforeOffset: 0
    })
    expect((await call()).name).toBe('transcript-ses_abc123-20260913.md')
  })

  it('answers every failure with a code from the closed set', async () => {
    const codes = new Set([
      'transcript_unavailable',
      'transcript_empty',
      'transcript_too_large',
      'transcript_build_failed',
      'transcript_remote_host_unsupported'
    ])
    read.mockResolvedValue({ error: 'anything at all' })
    const result = await call()
    expect(codes.has(result.error as string)).toBe(true)
  })

  it('rejects params that name no session or no host identity', () => {
    expect(method.params?.safeParse({ ...params, sessionId: '' }).success).toBe(false)
    expect(method.params?.safeParse({ ...params, expectedConnectionId: undefined }).success).toBe(
      false
    )
    expect(method.params?.safeParse(params).success).toBe(true)
    expect(method.params?.safeParse({ ...params, expectedConnectionId: 'server-a' }).success).toBe(
      true
    )
  })
})
