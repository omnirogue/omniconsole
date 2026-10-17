import { describe, expect, it, vi } from 'vitest'
import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { createSshTranscriptHostAccess } from './ssh-transcript-host-access'

function access(request = vi.fn()) {
  return {
    request,
    transcripts: createSshTranscriptHostAccess({ request } as unknown as SshChannelMultiplexer)
  }
}

describe('SSH transcript host access', () => {
  it('uses the owning host index and verifies both provider and session identity', async () => {
    const { request, transcripts } = access()
    request.mockResolvedValue({
      agent: 'claude',
      sessionId: 'session-a',
      filePath: '/remote/session.jsonl'
    })
    const controller = new AbortController()
    expect(await transcripts.resolveSource('openclaude', 'session-a', controller.signal)).toBe(
      '/remote/session.jsonl'
    )
    expect(request).toHaveBeenCalledWith(
      'transcript.resolveSource',
      {
        agent: 'openclaude',
        sessionId: 'session-a'
      },
      { signal: controller.signal, timeoutMs: 130_000 }
    )
    request.mockResolvedValue({ agent: 'codex', sessionId: 'session-a', filePath: '/other.jsonl' })
    await expect(transcripts.resolveSource('claude', 'session-a')).rejects.toThrow('identity')
    request.mockResolvedValue({ agent: 'claude', sessionId: 'session-b', filePath: '/other.jsonl' })
    await expect(transcripts.resolveSource('claude', 'session-a')).rejects.toThrow('identity')
  })

  it('reports older relays explicitly without substituting a local source', async () => {
    const { request, transcripts } = access()
    request.mockRejectedValue(Object.assign(new Error('Method not found'), { code: -32601 }))
    await expect(transcripts.resolveSource('kimi', 'session')).rejects.toThrow(
      'Update the SSH relay'
    )
    await expect(
      transcripts.readOpenCodePage({ agent: 'opencode', sessionId: 'ses_a' })
    ).rejects.toThrow('Update the SSH relay')
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('removes the client SSH identity before invoking the owning host OpenCode reader', async () => {
    const { request, transcripts } = access()
    request.mockResolvedValue({ source: { connectionId: null }, error: 'Fixture read refusal' })
    const cursor = {
      filePath: '/remote/frozen.jsonl',
      byteOffset: 10,
      snapshotSize: 100,
      fileIdentity: 'file',
      sourceEpoch: 'epoch',
      observedSize: 100,
      observedMtime: 0,
      connectionId: 'ssh-owner',
      agent: 'opencode',
      sessionId: 'ses_a'
    }
    await transcripts.readOpenCodePage({
      agent: 'opencode',
      sessionId: 'ses_a',
      connectionId: 'ssh-owner',
      cursor
    })
    expect(request).toHaveBeenCalledWith(
      'transcript.readOpenCodePage',
      expect.objectContaining({
        connectionId: undefined,
        cursor: expect.objectContaining({ connectionId: null, sessionId: 'ses_a' })
      }),
      expect.anything()
    )
    request.mockResolvedValue({ source: { connectionId: 'another-host' }, messages: [] })
    await expect(
      transcripts.readOpenCodePage({ agent: 'opencode', sessionId: 'ses_a' })
    ).rejects.toThrow('acknowledge')
  })
})

it('requires SSH OMP tail capability and the exact provider session acknowledgement', async () => {
  const { request, transcripts } = access()
  const params = { agent: 'omp' as const, sessionId: 'omp-session', limit: 30 }
  const response = {
    capability: 'omp-transcript-tail-v1',
    agent: 'omp',
    sessionId: 'omp-session',
    result: { messages: [], hasMore: false }
  }
  request.mockResolvedValue(response)
  await expect(transcripts.readOmpTail!(params)).resolves.toEqual(response.result)
  expect(request).toHaveBeenCalledWith('transcript.readOmpTailV1', params, {
    signal: undefined,
    timeoutMs: 130_000
  })
  request.mockResolvedValue({ ...response, sessionId: 'other' })
  await expect(transcripts.readOmpTail!(params)).rejects.toThrow('capability_unavailable')
  request.mockResolvedValue({ ...response, capability: undefined })
  await expect(transcripts.readOmpTail!(params)).rejects.toThrow('capability_unavailable')
  request.mockRejectedValue(Object.assign(new Error('Method not found'), { code: -32601 }))
  await expect(transcripts.readOmpTail!(params)).rejects.toThrow('Update the SSH relay')
})
