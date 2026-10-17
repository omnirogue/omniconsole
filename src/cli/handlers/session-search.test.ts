import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeCommandPositionals, parseArgs, specPaths } from '../args'
import type { RuntimeClient } from '../runtime-client'
import { COMMAND_SPECS } from '../specs'
import {
  formatSessionSearchHosts,
  formatSessionSearchResult,
  SESSION_SEARCH_HANDLERS
} from './session-search'
import type { SessionSearchHostStatus } from '../../shared/session-search-types'

const PATHS = COMMAND_SPECS.flatMap((spec) => specPaths(spec))

async function run(argv: string[], json = false) {
  const parsed = normalizeCommandPositionals(COMMAND_SPECS, parseArgs(argv, PATHS))
  const call = vi.fn(async () => ({
    id: '1',
    ok: true,
    result: { query: 'q', hits: [], hosts: [], tookMs: 1 },
    _meta: { runtimeId: 'r' }
  }))
  await SESSION_SEARCH_HANDLERS[parsed.commandPath.join(' ')]!({
    flags: parsed.flags,
    client: { call } as unknown as RuntimeClient,
    cwd: '/tmp',
    json
  })
  return call
}

describe('omni session search', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('joins unquoted words into one query and passes the limit', async () => {
    const call = await run(['session', 'search', 'omnirogue', 'production', '--limit', '5'])
    expect(call).toHaveBeenCalledWith('sessionSearch.query', {
      query: 'omnirogue production',
      limit: 5,
      includeRemote: true
    })
  })

  it('stays on this computer with --local', async () => {
    const call = await run(['session', 'search', 'Uma', '--local'])
    expect(call).toHaveBeenCalledWith('sessionSearch.query', {
      query: 'Uma',
      includeRemote: false
    })
  })

  it('prints why each session matched and which hosts answered', () => {
    const text = formatSessionSearchResult({
      query: 'uma',
      tookMs: 3,
      hits: [
        {
          sessionKey: 'claude:s1',
          sessionId: 's1',
          agent: 'claude',
          hostLabel: 'mac-studio',
          executionHostId: 'local',
          title: 'OmniRogue side menu',
          cwd: '/w',
          transcriptPath: '/t/s1.jsonl',
          lastActivityAt: Date.UTC(2026, 8, 24, 12),
          score: 9,
          reasons: ['“uma” in 45 messages'],
          snippets: [{ role: 'user', text: 'handoff for \\u0002uma\\u0003' }],
          summary: 'Goal: simplify',
          summarySource: 'model'
        }
      ],
      hosts: [
        {
          hostLabel: 'mac-studio',
          executionHostId: 'local',
          state: 'searched',
          indexedSessions: 900
        },
        {
          hostLabel: 'mw0003',
          executionHostId: 'runtime:e',
          state: 'unreachable',
          message: 'timeout'
        }
      ]
    })
    expect(text).toContain('why: “uma” in 45 messages')
    expect(text).toContain('“handoff for [uma]”')
    expect(text).toContain('Searched — mac-studio (900 sessions)')
    expect(text).toContain('Not searched — not reachable: 1 (mw0003)')
  })

  it.each<{ hosts: SessionSearchHostStatus[] }>([
    { hosts: [] },
    { hosts: [{ hostLabel: 'worker', executionHostId: 'ssh:one', state: 'unsupported' }] },
    { hosts: [{ hostLabel: 'worker', executionHostId: 'runtime:one', state: 'failed' }] },
    {
      hosts: [{ hostLabel: 'worker', executionHostId: 'local', state: 'searched', pendingFiles: 2 }]
    }
  ])('does not claim absent conversations when coverage is incomplete: %j', ({ hosts }) => {
    const text = formatSessionSearchResult({ query: 'q', hits: [], hosts, tookMs: 1 })
    expect(text).toContain('Search coverage is incomplete.')
    expect(text).not.toContain('No conversation mentions')
  })

  it('groups a long host list by outcome instead of listing every SSH target', () => {
    const unreachable = Array.from({ length: 41 }, (_, i) => ({
      hostLabel: `ssh-${i}`,
      executionHostId: `ssh:${i}`,
      state: 'unreachable' as const
    }))
    const text = formatSessionSearchHosts([
      {
        hostLabel: 'mac-studio',
        executionHostId: 'local',
        state: 'searched',
        indexedSessions: 5,
        pendingFiles: 2
      },
      { hostLabel: 'mw0001', executionHostId: 'runtime:a', state: 'unsupported' },
      ...unreachable
    ])
    expect(text).toBe(
      'Searched — mac-studio (5 sessions, still indexing 2 files)\n' +
        'Not searched — needs an update: 1 (mw0001) · not reachable: 41 (ssh-0, ssh-1, ssh-2, ssh-3 +37 more)'
    )
  })
})
