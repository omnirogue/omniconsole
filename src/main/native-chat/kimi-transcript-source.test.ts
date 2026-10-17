import { describe, expect, it, vi } from 'vitest'
import {
  MAX_KIMI_TRANSCRIPT_STATE_BYTES,
  resolveKimiTranscriptSource,
  type KimiTranscriptSourceAccess
} from './kimi-transcript-source'

const sessionId = 'session_4243babe-c33c-4ca3-8245-689c9e34ba3b'
const sessionDir = `/rented/home/.kimi-code/sessions/wd_project_hash/${sessionId}`
const statePath = `${sessionDir}/state.json`
const wirePath = `${sessionDir}/agents/main/wire.jsonl`

function accessTo(
  state: unknown = {
    agents: { main: { type: 'main', parentAgentId: null } }
  }
) {
  return { readFile: vi.fn(async () => Buffer.from(JSON.stringify(state))) }
}

describe('resolveKimiTranscriptSource', () => {
  it('resolves the canonical main wire log with bounded owning-host metadata access', async () => {
    const access = accessTo()
    await expect(
      resolveKimiTranscriptSource({ transcriptPath: statePath, sessionId }, access)
    ).resolves.toEqual({ filePath: wirePath, format: 'jsonl', statePath, agentId: 'main' })
    expect(access.readFile).toHaveBeenCalledExactlyOnceWith(
      statePath,
      MAX_KIMI_TRANSCRIPT_STATE_BYTES
    )
  })

  it('uses the parentless primary agent even when subagents come first', async () => {
    const access = accessTo({
      agents: {
        worker: { type: 'sub', parentAgentId: 'primary_1' },
        fork: { type: 'main', parentAgentId: 'primary_1' },
        primary_1: { type: 'main' }
      }
    })
    await expect(
      resolveKimiTranscriptSource({ transcriptPath: statePath }, access)
    ).resolves.toMatchObject({ filePath: `${sessionDir}/agents/primary_1/wire.jsonl` })
  })

  it('does not mistake v2 parent labels for another primary agent', async () => {
    const access = accessTo({
      agents: {
        worker: { type: 'main', labels: { parentAgentId: 'main' } },
        main: { type: 'main', labels: {} }
      }
    })
    await expect(
      resolveKimiTranscriptSource({ transcriptPath: statePath }, access)
    ).resolves.toMatchObject({ filePath: wirePath })
  })

  it('ignores copied homedirs and fork metadata instead of reading another session or host', async () => {
    const access = accessTo({
      forkedFrom: 'session_other',
      agents: {
        main: {
          type: 'main',
          parentAgentId: null,
          homedir: '/dispatcher/private/.kimi-code/sessions/other/agents/main',
          forkedFrom: 'other-agent'
        }
      }
    })
    await expect(
      resolveKimiTranscriptSource({ transcriptPath: statePath, sessionId }, access)
    ).resolves.toMatchObject({ filePath: wirePath })
    expect(access.readFile).toHaveBeenCalledTimes(1)
  })

  it.each([
    [
      'C:\\Users\\sal\\.kimi-code\\sessions\\session_one\\state.json',
      'C:\\Users\\sal\\.kimi-code\\sessions\\session_one\\agents\\main\\wire.jsonl'
    ],
    [
      'C:/Users/maintainer/.kimi-code/sessions/session_one/state.json',
      'C:\\Users\\sal\\.kimi-code\\sessions\\session_one\\agents\\main\\wire.jsonl'
    ],
    [
      '\\\\wsl.localhost\\Ubuntu\\home\\sal\\.kimi-code\\sessions\\session_one\\state.json',
      '\\\\wsl.localhost\\Ubuntu\\home\\sal\\.kimi-code\\sessions\\session_one\\agents\\main\\wire.jsonl'
    ],
    [
      '//server/share/.kimi-code/sessions/session_one/state.json',
      '\\\\server\\share\\.kimi-code\\sessions\\session_one\\agents\\main\\wire.jsonl'
    ]
  ])('preserves owning-host path semantics for %s', async (transcriptPath, expected) => {
    await expect(
      resolveKimiTranscriptSource({ transcriptPath }, accessTo())
    ).resolves.toMatchObject({ filePath: expected })
  })

  it('preserves an explicit JSONL source without metadata discovery', async () => {
    const access = accessTo()
    const transcriptPath = '/rented/home/.kimi2/sessions/session_one/context.jsonl'
    await expect(resolveKimiTranscriptSource({ transcriptPath }, access)).resolves.toEqual({
      filePath: transcriptPath,
      format: 'jsonl'
    })
    expect(access.readFile).not.toHaveBeenCalled()
  })

  it.each(['relative/state.json', '~/sessions/state.json', '/tmp/state.json\0'])(
    'refuses a non-authoritative path %s before any read',
    async (transcriptPath) => {
      const access = accessTo()
      await expect(resolveKimiTranscriptSource({ transcriptPath }, access)).rejects.toThrow(
        'absolute transcript path'
      )
      expect(access.readFile).not.toHaveBeenCalled()
    }
  )

  it('refuses arbitrary JSON documents instead of treating them as conversation metadata', async () => {
    const access = accessTo()
    await expect(
      resolveKimiTranscriptSource({ transcriptPath: '/tmp/config.json' }, access)
    ).rejects.toThrow('state.json or authoritative JSONL transcript')
    expect(access.readFile).not.toHaveBeenCalled()
  })

  it.each([
    '/rented/link/../session_one/state.json',
    'C:\\rented\\link\\..\\session_one\\state.json',
    '//server/share/link/../session_one/state.json'
  ])(
    'refuses parent-directory state paths before sibling normalization: %s',
    async (transcriptPath) => {
      const access = accessTo()
      await expect(resolveKimiTranscriptSource({ transcriptPath }, access)).rejects.toThrow(
        'parent-directory components'
      )
      expect(access.readFile).not.toHaveBeenCalled()
    }
  )

  it('rejects a state path belonging to another session before any read', async () => {
    const access = accessTo()
    await expect(
      resolveKimiTranscriptSource({ transcriptPath: statePath, sessionId: 'other' }, access)
    ).rejects.toThrow('different source session')
    expect(access.readFile).not.toHaveBeenCalled()
  })

  it('rejects a mismatched v2 state identity', async () => {
    const access = accessTo({ id: 'other', agents: { main: { type: 'main' } } })
    await expect(
      resolveKimiTranscriptSource({ transcriptPath: statePath, sessionId }, access)
    ).rejects.toThrow('different source session')
  })

  it.each([{}, { agents: null }, { agents: [] }, { agents: 'main' }])(
    'refuses missing or corrupt agent maps',
    async (state) => {
      await expect(
        resolveKimiTranscriptSource({ transcriptPath: statePath }, accessTo(state))
      ).rejects.toThrow('no authoritative agent map')
    }
  )

  it.each([
    { agents: {} },
    { agents: { main: { type: 'sub' } } },
    { agents: { main: { type: 'main' }, alternative: { type: 'main' } } }
  ])('refuses ambiguous or absent primary agents', async (state) => {
    await expect(
      resolveKimiTranscriptSource({ transcriptPath: statePath }, accessTo(state))
    ).rejects.toThrow('exactly one primary agent')
  })

  it.each(['..', '../elsewhere', '/elsewhere', '..\\elsewhere', 'C:elsewhere'])(
    'refuses path traversal through the primary identifier %s',
    async (agentId) => {
      const access = accessTo({ agents: { [agentId]: { type: 'main' } } })
      await expect(
        resolveKimiTranscriptSource({ transcriptPath: statePath }, access)
      ).rejects.toThrow('invalid primary agent identifier')
      expect(access.readFile).toHaveBeenCalledTimes(1)
    }
  )

  it.each([Buffer.from('{bad'), Buffer.from([0xff])])(
    'refuses corrupt metadata bytes',
    async (bytes) => {
      const access = { readFile: vi.fn(async () => bytes) }
      await expect(
        resolveKimiTranscriptSource({ transcriptPath: statePath }, access)
      ).rejects.toThrow('not valid UTF-8 JSON')
    }
  )

  it.each([{ state: null }, { state: [] }, { state: true }, { state: 'state' }])(
    'refuses non-object state JSON',
    async ({ state }) => {
      await expect(
        resolveKimiTranscriptSource({ transcriptPath: statePath }, accessTo(state))
      ).rejects.toThrow('must be a JSON object')
    }
  )

  it('defensively refuses an oversized response even when its access callback omits the cap', async () => {
    const access = {
      readFile: vi.fn(async () => Buffer.alloc(MAX_KIMI_TRANSCRIPT_STATE_BYTES + 1))
    }
    await expect(
      resolveKimiTranscriptSource({ transcriptPath: statePath }, access)
    ).rejects.toThrow('metadata exceeds the complete capture limit')
  })

  it('propagates owning-host read failures without substituting a local path', async () => {
    const failure = new Error('SSH connection changed')
    const access = {
      readFile: vi.fn(async () => {
        throw failure
      })
    }
    await expect(resolveKimiTranscriptSource({ transcriptPath: statePath }, access)).rejects.toBe(
      failure
    )
    expect(access.readFile).toHaveBeenCalledTimes(1)
  })

  it('honors cancellation before and after the metadata read', async () => {
    const controller = new AbortController()
    const access: KimiTranscriptSourceAccess = {
      readFile: vi.fn(async () => {
        controller.abort()
        return Buffer.from('{}')
      }),
      signal: controller.signal
    }
    await expect(
      resolveKimiTranscriptSource({ transcriptPath: statePath }, access)
    ).rejects.toThrow('aborted')
    expect(access.readFile).toHaveBeenCalledTimes(1)
    await expect(
      resolveKimiTranscriptSource({ transcriptPath: statePath }, access)
    ).rejects.toThrow('aborted')
    expect(access.readFile).toHaveBeenCalledTimes(1)
  })
})
