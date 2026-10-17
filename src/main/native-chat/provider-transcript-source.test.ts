import { describe, expect, it, vi } from 'vitest'
import {
  MAX_PROVIDER_TRANSCRIPT_METADATA_BYTES,
  resolveProviderTranscriptSource
} from './provider-transcript-source'

const fixtures = [
  {
    agent: 'grok',
    sessionId: 'grok-session',
    transcriptPath: '/rented/.grok/sessions/%2Frepo/grok-session/summary.json',
    historyPath: '/rented/.grok/sessions/%2Frepo/grok-session/chat_history.jsonl',
    metadata: { info: { id: 'grok-session', cwd: '/repo' }, generated_title: 'Saved title' },
    format: 'jsonl'
  },
  {
    agent: 'rovo',
    sessionId: 'rovo-session',
    transcriptPath: '/rented/.rovodev/sessions/rovo-session/metadata.json',
    historyPath: '/rented/.rovodev/sessions/rovo-session/session_context.json',
    metadata: { title: 'Saved title', workspace_path: '/repo' },
    format: 'json'
  },
  {
    agent: 'cline',
    sessionId: '1786466194549_xrzrl',
    transcriptPath: '/rented/.cline/data/sessions/1786466194549_xrzrl/1786466194549_xrzrl.json',
    historyPath:
      '/rented/.cline/data/sessions/1786466194549_xrzrl/1786466194549_xrzrl.messages.json',
    metadata: { session_id: '1786466194549_xrzrl', cwd: '/repo' },
    format: 'json'
  }
] as const

function accessTo(metadata: unknown) {
  return { readFile: vi.fn(async () => Buffer.from(JSON.stringify(metadata))) }
}

describe('resolveProviderTranscriptSource', () => {
  it.each(fixtures)(
    'resolves $agent indexed metadata to its full companion history',
    async (fixture) => {
      const access = accessTo(fixture.metadata)
      await expect(resolveProviderTranscriptSource(fixture, access)).resolves.toEqual({
        filePath: fixture.historyPath,
        format: fixture.format
      })
      expect(access.readFile).toHaveBeenCalledExactlyOnceWith(
        fixture.transcriptPath,
        MAX_PROVIDER_TRANSCRIPT_METADATA_BYTES
      )
    }
  )

  it.each(fixtures)(
    'does not read metadata again for an exact $agent history path',
    async (fixture) => {
      const access = accessTo(fixture.metadata)
      await expect(
        resolveProviderTranscriptSource(
          {
            ...fixture,
            transcriptPath: fixture.historyPath
          },
          access
        )
      ).resolves.toEqual({ filePath: fixture.historyPath, format: fixture.format })
      expect(access.readFile).not.toHaveBeenCalled()
    }
  )

  it.each(fixtures)('refuses $agent indirection without owning-host access', async (fixture) => {
    await expect(resolveProviderTranscriptSource(fixture)).rejects.toThrow(
      'access to its owning host'
    )
  })

  it.each(fixtures)('ignores embedded cross-host paths in $agent metadata', async (fixture) => {
    const access = accessTo({
      ...fixture.metadata,
      transcriptPath: '/dispatcher/private/history.jsonl',
      historyPath: '/other-session/history.jsonl',
      session_context: '/other/session.json'
    })
    await expect(resolveProviderTranscriptSource(fixture, access)).resolves.toEqual({
      filePath: fixture.historyPath,
      format: fixture.format
    })
    expect(access.readFile).toHaveBeenCalledTimes(1)
  })

  it.each([fixtures[0], fixtures[2]])(
    'supports $agent metadata identities overriding directory names',
    async (fixture) => {
      const metadata =
        fixture.agent === 'grok'
          ? { info: { id: '  actual-session  ' } }
          : { session_id: '  actual-session  ' }
      const access = accessTo(metadata)
      await expect(
        resolveProviderTranscriptSource({ ...fixture, sessionId: 'actual-session' }, access)
      ).resolves.toEqual({ filePath: fixture.historyPath, format: fixture.format })
    }
  )

  it.each([fixtures[2]])(
    'proves $agent direct JSON identity overrides through sibling metadata',
    async (fixture) => {
      const metadata = { session_id: 'actual-session' }
      const access = accessTo(metadata)
      await expect(
        resolveProviderTranscriptSource(
          {
            ...fixture,
            sessionId: 'actual-session',
            transcriptPath: fixture.historyPath
          },
          access
        )
      ).resolves.toEqual({ filePath: fixture.historyPath, format: fixture.format })
      expect(access.readFile).toHaveBeenCalledExactlyOnceWith(
        fixture.transcriptPath,
        MAX_PROVIDER_TRANSCRIPT_METADATA_BYTES
      )
    }
  )

  it.each([fixtures[0], fixtures[2]])(
    'rejects conflicting $agent metadata identities',
    async (fixture) => {
      const metadata =
        fixture.agent === 'grok'
          ? { info: { id: 'other-session' } }
          : { session_id: 'other-session' }
      await expect(resolveProviderTranscriptSource(fixture, accessTo(metadata))).rejects.toThrow(
        'different source session'
      )
    }
  )

  it.each([fixtures[0], fixtures[2]])(
    'falls back to $agent path identity when metadata ID is blank',
    async (fixture) => {
      const metadata = fixture.agent === 'grok' ? { info: { id: '  ' } } : { session_id: '  ' }
      await expect(resolveProviderTranscriptSource(fixture, accessTo(metadata))).resolves.toEqual({
        filePath: fixture.historyPath,
        format: fixture.format
      })
    }
  )

  it('uses Grok scanner trailing-UUID fallback for a prefixed directory', async () => {
    const sessionId = '4243babe-c33c-4ca3-8245-689c9e34ba3b'
    const sessionDir = `/rented/.grok/sessions/project/session_${sessionId}`
    await expect(
      resolveProviderTranscriptSource(
        {
          agent: 'grok',
          sessionId,
          transcriptPath: `${sessionDir}/summary.json`
        },
        accessTo({})
      )
    ).resolves.toEqual({
      filePath: `${sessionDir}/chat_history.jsonl`,
      format: 'jsonl'
    })
  })

  it('binds Rovo identity to its directory and ignores non-authoritative metadata ID fields', async () => {
    await expect(
      resolveProviderTranscriptSource(fixtures[1], accessTo({ id: 'not-the-session' }))
    ).resolves.toEqual({ filePath: fixtures[1].historyPath, format: 'json' })
    const access = accessTo({ session_id: 'other' })
    await expect(
      resolveProviderTranscriptSource({ ...fixtures[1], sessionId: 'other' }, access)
    ).rejects.toThrow('different source session')
    expect(access.readFile).not.toHaveBeenCalled()
  })

  it('refuses a Cline manifest whose filename does not match its enclosing directory', async () => {
    const access = accessTo({ session_id: 'one' })
    await expect(
      resolveProviderTranscriptSource(
        {
          agent: 'cline',
          sessionId: 'one',
          transcriptPath: '/rented/.cline/data/sessions/one/two.json'
        },
        access
      )
    ).rejects.toThrow('not its indexed metadata or conversation history')
    expect(access.readFile).not.toHaveBeenCalled()
  })

  it.each([
    {
      agent: 'grok',
      transcriptPath: 'C:/Users/Sal/.grok/sessions/project/one/summary.json',
      filePath: 'C:\\Users\\Sal\\.grok\\sessions\\project\\one\\chat_history.jsonl',
      format: 'jsonl'
    },
    {
      agent: 'rovo',
      transcriptPath:
        '\\\\wsl.localhost\\Ubuntu\\home\\sal\\.rovodev\\sessions\\one\\metadata.json',
      filePath:
        '\\\\wsl.localhost\\Ubuntu\\home\\sal\\.rovodev\\sessions\\one\\session_context.json',
      format: 'json'
    },
    {
      agent: 'cline',
      transcriptPath: 'C:\\Users\\Sal\\.cline\\data\\sessions\\one\\one.json',
      filePath: 'C:\\Users\\Sal\\.cline\\data\\sessions\\one\\one.messages.json',
      format: 'json'
    },
    {
      agent: 'rovo',
      transcriptPath: '//server/share/sessions/one/metadata.json',
      filePath: '\\\\server\\share\\sessions\\one\\session_context.json',
      format: 'json'
    }
  ])('derives $agent companions with owning-host Windows/UNC semantics', async (fixture) => {
    await expect(
      resolveProviderTranscriptSource({ ...fixture, sessionId: 'one' }, accessTo({}))
    ).resolves.toEqual({ filePath: fixture.filePath, format: fixture.format })
  })

  it.each([
    { agent: 'hermes', transcriptPath: '/rented/.hermes/sessions/session_one.json' },
    { agent: 'hermes', transcriptPath: '/rented/.hermes/sessions/remote-indexed.json' },
    { agent: 'devin', transcriptPath: '/rented/.local/share/devin/cli/transcripts/ATIF-one.json' },
    { agent: 'devin', transcriptPath: '/rented/.local/share/devin/cli/transcripts/one.json' },
    { agent: 'gemini', transcriptPath: '/rented/.gemini/tmp/project/chats/session-one.json' }
  ])('preserves the full $agent document without applying a metadata read cap', async (fixture) => {
    const access = accessTo({})
    await expect(
      resolveProviderTranscriptSource({ ...fixture, sessionId: 'one' }, access)
    ).resolves.toEqual({ filePath: fixture.transcriptPath, format: 'json' })
    expect(access.readFile).not.toHaveBeenCalled()
  })

  it.each(['grok', 'rovo', 'cline', 'kimi', 'omp'])(
    'preserves %s authoritative legacy or rotated JSONL paths without metadata lookup',
    async (agent) => {
      const transcriptPath = '/rented/retained/session-one.2026-09-12.jsonl'
      const access = accessTo({ info: { id: 'other' }, session_id: 'other' })
      await expect(
        resolveProviderTranscriptSource({ agent, sessionId: 'one', transcriptPath }, access)
      ).resolves.toEqual({ filePath: transcriptPath, format: 'jsonl' })
      expect(access.readFile).not.toHaveBeenCalled()
    }
  )

  it.each(['/rented/link/../one/summary.json', 'C:\\rented\\link\\..\\one\\summary.json'])(
    'refuses parent-directory metadata paths before sibling normalization: %s',
    async (transcriptPath) => {
      const access = accessTo({ info: { id: 'one' } })
      await expect(
        resolveProviderTranscriptSource({ agent: 'grok', sessionId: 'one', transcriptPath }, access)
      ).rejects.toThrow('parent-directory components')
      expect(access.readFile).not.toHaveBeenCalled()
    }
  )

  it('reuses Kimi state resolution', async () => {
    await expect(
      resolveProviderTranscriptSource(
        {
          agent: 'kimi',
          sessionId: 'session_one',
          transcriptPath: '/rented/.kimi-code/sessions/session_one/state.json'
        },
        accessTo({ agents: { main: { type: 'main', parentAgentId: null } } })
      )
    ).resolves.toEqual({
      filePath: '/rented/.kimi-code/sessions/session_one/agents/main/wire.jsonl',
      format: 'jsonl'
    })
  })

  it.each(['relative/summary.json', '~/sessions/summary.json', '/rented/summary.json\0'])(
    'rejects a non-authoritative path before any read: %s',
    async (transcriptPath) => {
      const access = accessTo({})
      await expect(
        resolveProviderTranscriptSource({ agent: 'grok', sessionId: 'one', transcriptPath }, access)
      ).rejects.toThrow('absolute transcript path')
      expect(access.readFile).not.toHaveBeenCalled()
    }
  )

  it.each([Buffer.from('{bad'), Buffer.from([0xff])])(
    'refuses corrupt metadata bytes',
    async (bytes) => {
      await expect(
        resolveProviderTranscriptSource(fixtures[0], { readFile: vi.fn(async () => bytes) })
      ).rejects.toThrow('not valid UTF-8 JSON')
    }
  )

  it.each([{ value: null }, { value: [] }, { value: true }])(
    'refuses non-object metadata',
    async ({ value }) => {
      await expect(resolveProviderTranscriptSource(fixtures[0], accessTo(value))).rejects.toThrow(
        'must be a JSON object'
      )
    }
  )

  it('refuses oversized metadata even if the owning-host callback omits its cap', async () => {
    const access = {
      readFile: vi.fn(async () => Buffer.alloc(MAX_PROVIDER_TRANSCRIPT_METADATA_BYTES + 1))
    }
    await expect(resolveProviderTranscriptSource(fixtures[0], access)).rejects.toThrow(
      'capture limit'
    )
  })

  it('propagates an owning-host access failure without returning summary-only history', async () => {
    const failure = new Error('SSH source disconnected')
    const access = {
      readFile: vi.fn(async () => {
        throw failure
      })
    }
    await expect(resolveProviderTranscriptSource(fixtures[0], access)).rejects.toBe(failure)
    expect(access.readFile).toHaveBeenCalledTimes(1)
  })

  it('honors cancellation before and after metadata access', async () => {
    const controller = new AbortController()
    const access = {
      signal: controller.signal,
      readFile: vi.fn(async () => {
        controller.abort()
        return Buffer.from('{}')
      })
    }
    await expect(resolveProviderTranscriptSource(fixtures[0], access)).rejects.toThrow('aborted')
    await expect(resolveProviderTranscriptSource(fixtures[0], access)).rejects.toThrow('aborted')
    expect(access.readFile).toHaveBeenCalledTimes(1)
  })
})
