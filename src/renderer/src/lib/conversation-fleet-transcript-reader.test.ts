import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readConversationFleetTranscript } from './conversation-fleet-transcript-reader'

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.rpc }))

const body = '# Session transcript\n'
const sha = createHash('sha256').update(body).digest('hex')
const ok = {
  name: 'transcript-session-1-20260913.md',
  contentBase64: Buffer.from(body).toString('base64'),
  sha256: sha,
  size: Buffer.byteLength(body),
  messageCount: 7,
  truncatedBlocks: 1,
  earlierMessagesOmitted: false,
  omittedRecords: 0
}
const source = { hostId: 'runtime:owner' as const, agent: 'codex', sessionId: 'session-1' }
const read = () =>
  readConversationFleetTranscript(source, '2026-09-13T09:30:00.000Z', new AbortController().signal)

beforeEach(() => mocks.rpc.mockReset())

describe('readConversationFleetTranscript', () => {
  it('returns the verified file for a clean session', async () => {
    mocks.rpc.mockResolvedValue(ok)
    const result = await read()
    expect(result).toMatchObject({ kind: 'file', messageCount: 7 })
    if (result.kind === 'file') {
      expect(result.file.sha256).toBe(sha)
      expect(result.file.name).toBe(ok.name)
    }
  })

  it('returns the refusal with a count and no transcript', async () => {
    mocks.rpc.mockResolvedValue({ reason: 'transcript_contains_protected_data', redactions: 3 })
    const result = await read()
    expect(result).toMatchObject({ kind: 'refused', redactions: 3 })
    if (result.kind === 'refused') {
      expect(result.message).toContain('3 values the redactor treats as a secret')
    }
  })

  it('names the singular value in a one-secret refusal', async () => {
    mocks.rpc.mockResolvedValue({ reason: 'transcript_contains_protected_data', redactions: 1 })
    const result = await read()
    expect(result.kind === 'refused' && result.message).toContain('contains 1 value the')
  })

  it('turns a host code into its own fixed sentence', async () => {
    mocks.rpc.mockResolvedValue({ error: 'transcript_unavailable' })
    await expect(read()).rejects.toThrow(/could not read this session/)
  })

  it('names the size for an oversized transcript', async () => {
    mocks.rpc.mockResolvedValue({ error: 'transcript_too_large', sizeBytes: 9 * 1024 * 1024 })
    await expect(read()).rejects.toThrow(/9 MiB, above the limit/)
  })

  it('refuses an SSH session before any call is made', async () => {
    await expect(
      readConversationFleetTranscript(
        { hostId: 'ssh:server-a', agent: 'codex', sessionId: 'session-1' },
        '2026-09-13T09:30:00.000Z',
        new AbortController().signal
      )
    ).rejects.toThrow(/session running over SSH cannot send its transcript/)
    // Never ask the runtime box for a session that lives on another machine.
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('states the host identity on every call so the host can refuse too', async () => {
    mocks.rpc.mockResolvedValue(ok)
    await read()
    expect(mocks.rpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'owner' },
      'transcripts.buildDeliverable',
      expect.objectContaining({ expectedConnectionId: null }),
      expect.anything()
    )
  })

  it('carries the omitted-record count back to the caller', async () => {
    mocks.rpc.mockResolvedValue({ ...ok, omittedRecords: 2 })
    const result = await read()
    expect(result.kind === 'file' && result.omittedRecords).toBe(2)
  })

  it('refuses bytes whose length disagrees with the declared size', async () => {
    mocks.rpc.mockResolvedValue({ ...ok, size: ok.size + 1 })
    await expect(read()).rejects.toThrow(/incomplete transcript bytes/)
  })

  it('refuses a result that is not the agreed wire shape', async () => {
    mocks.rpc.mockResolvedValue({ name: ok.name, contentBase64: ok.contentBase64 })
    await expect(read()).rejects.toThrow()
  })
})
