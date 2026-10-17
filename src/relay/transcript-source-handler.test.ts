import { SSH_OMP_CHAT_METHOD } from '../shared/ssh-native-chat'
import { readNativeChatTranscriptTail } from '../main/native-chat/transcript-tail-reader'
vi.mock('../main/native-chat/transcript-tail-reader', () => ({
  readNativeChatTranscriptTail: vi.fn()
}))
import { describe, expect, it, vi } from 'vitest'
import {
  AI_VAULT_AGENTS,
  type AiVaultListResult,
  type AiVaultScanIssue,
  type AiVaultSession
} from '../shared/ai-vault-types'
import type { RelayAiVaultServiceApi } from './ai-vault-service-client-state'
import type { RelayDispatcher, RequestContext } from './dispatcher'
import { TranscriptSourceHandler } from './transcript-source-handler'

type RequestHandler = (params: Record<string, unknown>, context: RequestContext) => Promise<unknown>

const METHOD = 'transcript.resolveSource'
const request = { agent: 'codex', sessionId: 'source-session' }

describe('TranscriptSourceHandler', () => {
  it('registers the fixed source method even when the index service is unavailable', async () => {
    const dispatcher = createMockDispatcher()
    new TranscriptSourceHandler(dispatcher.value)

    expect(dispatcher.methods()).toEqual([SSH_OMP_CHAT_METHOD, METHOD])
    await expect(dispatcher.call(request)).rejects.toThrow(/index.*unavailable/i)
  })

  it.each(AI_VAULT_AGENTS)(
    'resolves %s from the host index without returning previews',
    async (agent) => {
      const source = session({ agent })
      const { dispatcher, listSessions, resolveSessionTitles } = createFixture(result([source]))
      const controller = new AbortController()

      await expect(dispatcher.call({ ...request, agent }, controller.signal)).resolves.toEqual({
        agent,
        sessionId: source.sessionId,
        filePath: source.filePath
      })
      expect(listSessions).toHaveBeenCalledTimes(1)
      expect(listSessions).toHaveBeenCalledWith({ unlimited: true, force: true }, controller.signal)
      expect(resolveSessionTitles).not.toHaveBeenCalled()
    }
  )

  it('canonicalizes openclaude to the Claude source identity', async () => {
    const { dispatcher } = createFixture(result([session({ agent: 'claude' })]))

    await expect(dispatcher.call({ ...request, agent: 'openclaude' })).resolves.toEqual({
      agent: 'claude',
      sessionId: request.sessionId,
      filePath: '/host/transcripts/source-session.jsonl'
    })
  })

  it('forces a fresh unlimited index lookup for each request', async () => {
    const { dispatcher, listSessions } = createFixture(result())
    listSessions.mockResolvedValueOnce(result()).mockResolvedValueOnce(result([session()]))

    await expect(dispatcher.call(request)).resolves.toBeNull()
    await expect(dispatcher.call(request)).resolves.toEqual({
      ...request,
      filePath: '/host/transcripts/source-session.jsonl'
    })
    expect(listSessions.mock.calls).toEqual([
      [{ unlimited: true, force: true }, undefined],
      [{ unlimited: true, force: true }, undefined]
    ])
  })

  it('returns null for a healthy miss without using caller context as a transcript', async () => {
    const { dispatcher } = createFixture(result())

    await expect(
      dispatcher.call({
        ...request,
        filePath: '/client/transcript.jsonl',
        context: 'Caller supplied conversation preview',
        previewMessages: [{ role: 'user', text: 'Incomplete preview' }]
      })
    ).resolves.toBeNull()
  })

  it('does not substitute another agent or session with the same title', async () => {
    const { dispatcher } = createFixture(
      result([session({ agent: 'claude' }), session({ sessionId: 'source-session-other' })])
    )

    await expect(dispatcher.call(request)).resolves.toBeNull()
  })

  it.each(['ssh:rented-mac', 'runtime:other-mac'] as const)(
    'returns null for a source owned by %s even with a caller preview',
    async (executionHostId) => {
      const { dispatcher } = createFixture(result([session({ executionHostId })]))

      await expect(
        dispatcher.call({
          ...request,
          executionHostId,
          context: 'Caller preview must never become the transcript',
          previewMessages: [{ role: 'user', text: 'Caller preview' }]
        })
      ).resolves.toBeNull()
    }
  )

  it('selects the local source when remote hosts also report the same session identity', async () => {
    const { dispatcher } = createFixture(
      result([
        session({ executionHostId: 'ssh:other', filePath: '/other/transcript.jsonl' }),
        session(),
        session({ executionHostId: 'runtime:other', filePath: '/peer/transcript.jsonl' })
      ])
    )

    await expect(dispatcher.call(request)).resolves.toEqual({
      ...request,
      filePath: '/host/transcripts/source-session.jsonl'
    })
  })

  it('refuses distinct local paths for the same agent and session as ambiguous', async () => {
    const { dispatcher } = createFixture(
      result([session(), session({ filePath: '/other-profile/source-session.jsonl' })])
    )

    await expect(dispatcher.call(request)).rejects.toThrow(/ambig/i)
  })

  it('accepts duplicate index rows identifying the same source file', async () => {
    const { dispatcher } = createFixture(result([session(), session({ id: 'duplicate-row' })]))

    await expect(dispatcher.call(request)).resolves.toEqual({
      ...request,
      filePath: '/host/transcripts/source-session.jsonl'
    })
  })

  it.each([
    ['missing agent', { sessionId: request.sessionId }],
    ['unknown agent', { ...request, agent: 'unknown-provider' }],
    ['non-string agent', { ...request, agent: 1 }],
    ['padded agent', { ...request, agent: ' codex ' }],
    ['missing session', { agent: request.agent }],
    ['empty session', { ...request, sessionId: '' }],
    ['non-string session', { ...request, sessionId: 1 }],
    ['whitespace session', { ...request, sessionId: '   ' }],
    ['leading whitespace', { ...request, sessionId: ' source-session' }],
    ['trailing whitespace', { ...request, sessionId: 'source-session ' }],
    ['newline', { ...request, sessionId: 'source\nsession' }],
    ['null byte', { ...request, sessionId: 'source\u0000session' }],
    ['tab', { ...request, sessionId: 'source\tsession' }],
    ['delete control', { ...request, sessionId: 'source\u007fsession' }],
    ['overlong session', { ...request, sessionId: 's'.repeat(513) }]
  ] satisfies [string, Record<string, unknown>][])(
    'rejects %s before scanning',
    async (_label, params) => {
      const { dispatcher, listSessions } = createFixture(result())

      await expect(dispatcher.call(params)).rejects.toThrow()
      expect(listSessions).not.toHaveBeenCalled()
    }
  )

  it('accepts a 512-character session id unchanged', async () => {
    const sessionId = 's'.repeat(512)
    const { dispatcher } = createFixture(result([session({ sessionId })]))

    await expect(dispatcher.call({ ...request, sessionId })).resolves.toEqual({
      ...request,
      sessionId,
      filePath: '/host/transcripts/source-session.jsonl'
    })
  })

  it('reports a rejected index as unavailable instead of a healthy miss', async () => {
    const { dispatcher, listSessions } = createFixture(result())
    listSessions.mockRejectedValue(new Error('sidecar disconnected'))

    await expect(dispatcher.call(request)).rejects.toThrow(/index.*unavailable/i)
  })

  it('reports a cancelled index result as unavailable even if it contains a matching row', async () => {
    const { dispatcher } = createFixture({ ...result([session()]), cancelled: true })

    await expect(dispatcher.call(request)).rejects.toThrow(/index.*unavailable/i)
  })

  it.each([
    { agent: 'codex', path: '/host/.codex', message: 'Permission denied' },
    { agent: 'codex', executionHostId: 'local', path: '/host/.codex', message: 'Read failed' },
    { agent: 'codex', kind: 'scope', path: '/host/project', message: 'Scope unavailable' },
    { agent: 'claude', kind: 'scope', path: '/host/project', message: 'Host scope unavailable' },
    { agent: 'claude', kind: 'host', path: '/host', message: 'Host index unavailable' }
  ] satisfies AiVaultScanIssue[])(
    'reports relevant source issue $message as unavailable',
    async (issue) => {
      const { dispatcher } = createFixture(result([], [issue]))

      await expect(dispatcher.call(request)).rejects.toThrow(/index.*unavailable/i)
    }
  )

  it('refuses a matching row when a relevant scan issue leaves source ambiguity unresolved', async () => {
    const { dispatcher } = createFixture(
      result(
        [session()],
        [{ agent: 'codex', path: '/host/.codex-other', message: 'Other profile unreadable' }]
      )
    )

    await expect(dispatcher.call(request)).rejects.toThrow(/index.*unavailable/i)
  })

  it('keeps unrelated agent, other-host, and notice issues from turning a healthy miss into failure', async () => {
    const { dispatcher } = createFixture(
      result(
        [],
        [
          { agent: 'claude', path: '/host/.claude', message: 'Unrelated source failed' },
          {
            agent: 'codex',
            executionHostId: 'ssh:other',
            path: '/other',
            message: 'Other host failed'
          },
          { agent: 'codex', kind: 'notice', path: '', message: 'Scanner commentary' }
        ]
      )
    )

    await expect(dispatcher.call(request)).resolves.toBeNull()
  })

  it('preserves AbortError from the index service', async () => {
    const { dispatcher, listSessions } = createFixture(result())
    const error = new Error('The operation was aborted.')
    error.name = 'AbortError'
    listSessions.mockRejectedValue(error)

    await expect(dispatcher.call(request)).rejects.toBe(error)
  })

  it('rejects an already cancelled lookup before scanning', async () => {
    const { dispatcher, listSessions } = createFixture(result([session()]))
    const controller = new AbortController()
    controller.abort()

    await expect(dispatcher.call(request, controller.signal)).rejects.toMatchObject({
      name: 'AbortError'
    })
    expect(listSessions).not.toHaveBeenCalled()
  })

  it('does not return a source if cancellation arrives before the index response is consumed', async () => {
    const { dispatcher, listSessions } = createFixture(result())
    const controller = new AbortController()
    listSessions.mockImplementation(async () => {
      controller.abort()
      return result([session()])
    })

    await expect(dispatcher.call(request, controller.signal)).rejects.toMatchObject({
      name: 'AbortError'
    })
  })

  it('propagates cancellation of an in-flight source lookup through its signal', async () => {
    const { dispatcher, listSessions } = createFixture(result())
    const controller = new AbortController()
    listSessions.mockImplementation(
      (_params, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => reject(Object.assign(new Error('Lookup aborted'), { name: 'AbortError' })),
            { once: true }
          )
        })
    )
    const pending = dispatcher.call(request, controller.signal)
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })

    controller.abort()

    await rejected
    expect(listSessions).toHaveBeenCalledWith({ unlimited: true, force: true }, controller.signal)
  })
})

function result(
  sessions: AiVaultSession[] = [],
  issues: AiVaultScanIssue[] = []
): AiVaultListResult {
  return { sessions, issues, scannedAt: '2026-09-12T10:00:00.000Z' }
}

function session(overrides: Partial<AiVaultSession> = {}): AiVaultSession {
  return {
    id: 'indexed-source',
    executionHostId: 'local',
    agent: 'codex',
    sessionId: request.sessionId,
    title: 'Identical title is not source identity',
    cwd: '/host/project',
    branch: null,
    model: null,
    filePath: '/host/transcripts/source-session.jsonl',
    codexHome: '/host/.codex',
    createdAt: null,
    updatedAt: null,
    modifiedAt: '2026-09-12T10:00:00.000Z',
    messageCount: 100,
    totalTokens: 1234,
    previewMessages: [{ role: 'user', text: 'Private truncated preview', timestamp: null }],
    previewMessagesTruncated: true,
    firstUserPrompt: 'Private first prompt',
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: 'codex resume source-session',
    subagent: null,
    ...overrides
  }
}

function createFixture(scanResult: AiVaultListResult) {
  const dispatcher = createMockDispatcher()
  const listSessions = vi.fn<RelayAiVaultServiceApi['listSessions']>().mockResolvedValue(scanResult)
  const resolveSessionTitles = vi
    .fn<RelayAiVaultServiceApi['resolveSessionTitles']>()
    .mockResolvedValue({ titles: [] })
  new TranscriptSourceHandler(dispatcher.value, {
    service: { listSessions, resolveSessionTitles }
  })
  return { dispatcher, listSessions, resolveSessionTitles }
}

function createMockDispatcher() {
  const handlers = new Map<string, RequestHandler>()
  const value = {
    onRequest(method: string, handler: RequestHandler) {
      handlers.set(method, handler)
    }
  } as RelayDispatcher
  return {
    value,
    methods: () => [...handlers.keys()],
    call(params: Record<string, unknown>, signal?: AbortSignal, method = METHOD): Promise<unknown> {
      const handler = handlers.get(method)
      if (!handler) {
        throw new Error(`No handler for ${METHOD}`)
      }
      return handler(params, { clientId: 1, isStale: () => signal?.aborted ?? false, signal })
    }
  }
}

it('reads OMP Chat only from the host-indexed exact session and refuses client paths', async () => {
  const { dispatcher } = createFixture(result([session({ agent: 'omp' })]))
  vi.mocked(readNativeChatTranscriptTail).mockResolvedValue({
    messages: [],
    hasMore: false,
    beforeOffset: 0
  })
  const params = { agent: 'omp', sessionId: request.sessionId, limit: 20 }
  await expect(dispatcher.call(params, undefined, SSH_OMP_CHAT_METHOD)).resolves.toMatchObject({
    capability: 'omp-transcript-tail-v1',
    agent: 'omp',
    sessionId: request.sessionId,
    result: { messages: [], hasMore: false }
  })
  expect(readNativeChatTranscriptTail).toHaveBeenCalledWith(
    { ...params, filePath: '/host/transcripts/source-session.jsonl' },
    undefined
  )
  vi.mocked(readNativeChatTranscriptTail).mockClear()
  await expect(
    dispatcher.call({ ...params, transcriptPath: '/client/secret' }, undefined, SSH_OMP_CHAT_METHOD)
  ).rejects.toThrow()
  await expect(
    dispatcher.call({ ...params, agent: 'pi' }, undefined, SSH_OMP_CHAT_METHOD)
  ).rejects.toThrow()
  await expect(
    dispatcher.call({ ...params, sessionId: 'other' }, undefined, SSH_OMP_CHAT_METHOD)
  ).resolves.toMatchObject({ result: { notFound: true } })
  expect(readNativeChatTranscriptTail).not.toHaveBeenCalled()
})
