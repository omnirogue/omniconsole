import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeCommandPositionals, parseArgs, specPaths } from './args'
import type { RuntimeClient } from './runtime-client'
import { COMMAND_SPECS } from './specs'
import { formatSessionSearchResult, SESSION_SEARCH_HANDLERS } from './handlers/session-search'
import { joinSessionSearchSidebar } from './session-search-sidebar-join'
import type { SessionManageEntry } from '../shared/session-manage-types'
import type { SessionSearchHit, SessionSearchResult } from '../shared/session-search-types'

const PATHS = COMMAND_SPECS.flatMap((spec) => specPaths(spec))
const OPEN = '11111111-1111-4111-8111-111111111111'
const ARCHIVED = '22222222-2222-4222-8222-222222222222'
const CLOSED = '33333333-3333-4333-8333-333333333333'

function hit(sessionId: string, executionHostId = 'local'): SessionSearchHit {
  return {
    sessionKey: `claude:${sessionId}`,
    sessionId,
    agent: 'claude',
    hostLabel: 'mac-studio',
    executionHostId,
    title: `t-${sessionId.slice(0, 4)}`,
    cwd: '/w',
    transcriptPath: `/h/.claude/projects/-w/${sessionId}.jsonl`,
    lastActivityAt: null,
    score: 1,
    reasons: ['“parser” in 3 messages'],
    snippets: [],
    summary: null,
    summarySource: null
  }
}

function entry(overrides: Partial<SessionManageEntry>): SessionManageEntry {
  return {
    paneKey: 'tab-1:leaf',
    tabId: 'tab-1',
    terminal: null,
    title: 'Parser',
    agent: 'claude',
    kind: 'terminal',
    worktreeId: 'w',
    worktreePath: '/w',
    workspace: 'w',
    hostId: 'local',
    folder: null,
    saved: false,
    archived: false,
    pinned: false,
    verdict: 'live',
    state: 'idle',
    stateBasis: 'hook',
    agentForeground: true,
    lastActivityAt: null,
    waitingOn: null,
    pendingSteps: [],
    queueLength: 0,
    keepGoing: false,
    providerSessionId: null,
    transcriptPath: null,
    archiveKind: null,
    ...overrides
  }
}

const SESSIONS = [
  entry({ paneKey: 'tab-1:a', providerSessionId: OPEN }),
  entry({
    paneKey: 'tab-2:b',
    title: 'Old parser',
    providerSessionId: 'hook-id',
    transcriptPath: `/h/.claude/projects/-w/${ARCHIVED}.jsonl`,
    archived: true,
    archiveKind: 'automatic',
    verdict: 'exited',
    state: 'exited'
  })
]

const result = (hits: SessionSearchHit[]): SessionSearchResult => ({
  query: 'parser',
  hits,
  hosts: [{ hostLabel: 'mac-studio', executionHostId: 'local', state: 'searched' }],
  tookMs: 1
})

describe('joinSessionSearchSidebar', () => {
  it('gives every hit a ref and every row holding it, archived ones included', () => {
    const joined = joinSessionSearchSidebar(
      result([hit(OPEN), hit(ARCHIVED), hit(CLOSED)]),
      SESSIONS
    )
    expect(joined.sidebarJoin).toEqual({ state: 'joined' })
    expect(joined.hits.map((each) => each.ref)).toEqual([
      `claude:${OPEN}@local`,
      `claude:${ARCHIVED}@local`,
      `claude:${CLOSED}@local`
    ])
    expect(joined.hits[0]!.sidebar).toEqual([
      expect.objectContaining({ paneKey: 'tab-1:a', state: 'idle', archived: false })
    ])
    expect(joined.hits[1]!.sidebar).toEqual([
      expect.objectContaining({ paneKey: 'tab-2:b', archived: true, archiveKind: 'automatic' })
    ])
    // No row: its tab was closed.
    expect(joined.hits[2]!.sidebar).toEqual([])
  })

  it('never guesses rows against a controller that lists no provider ids', () => {
    const old = SESSIONS.map(
      ({ providerSessionId: _a, transcriptPath: _b, archiveKind: _c, ...rest }) => rest
    )
    const joined = joinSessionSearchSidebar(result([hit(OPEN)]), old as SessionManageEntry[])
    expect(joined.hits[0]!.ref).toBe(`claude:${OPEN}@local`)
    expect(joined.hits[0]!.sidebar).toBeUndefined()
    expect(joined.sidebarJoin?.state).toBe('unavailable')
  })

  it('prints the ref, the row and what to do with a closed one', () => {
    const text = formatSessionSearchResult(
      joinSessionSearchSidebar(result([hit(ARCHIVED), hit(CLOSED)]), SESSIONS)
    )
    expect(text).toContain(`ref claude:${ARCHIVED}@local`)
    expect(text).toContain(
      'in sidebar: pane tab-2:b · exited · exited · archived (automatically, finished)'
    )
    expect(text).toContain(
      `no sidebar row (its tab was closed): omni session resume --ref claude:${CLOSED}@local`
    )
  })
})

describe('omni session search joins the sidebar', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  async function run(client: Partial<RuntimeClient>) {
    const parsed = normalizeCommandPositionals(
      COMMAND_SPECS,
      parseArgs(['session', 'search', 'parser', '--json'], PATHS)
    )
    await SESSION_SEARCH_HANDLERS['session search']!({
      flags: parsed.flags,
      client: client as RuntimeClient,
      cwd: '/tmp',
      json: true
    })
    return JSON.parse(vi.mocked(console.log).mock.calls[0]![0] as string)
  }

  it('lists archived rows too and attaches them to the JSON hits', async () => {
    const call = vi.fn(async (method: string) => ({
      id: '1',
      ok: true,
      result: method === 'sessionManage.list' ? { sessions: SESSIONS } : result([hit(ARCHIVED)]),
      _meta: { runtimeId: 'r' }
    }))
    const printed = await run({ call } as unknown as RuntimeClient)
    expect(call).toHaveBeenCalledWith(
      'sessionManage.list',
      { includeArchived: true },
      expect.anything()
    )
    expect(printed.result.hits[0].ref).toBe(`claude:${ARCHIVED}@local`)
    expect(printed.result.hits[0].sidebar[0].paneKey).toBe('tab-2:b')
  })

  it('keeps the hits when the sidebar cannot be read, and says why', async () => {
    const call = vi.fn(async (method: string) => {
      if (method === 'sessionManage.list') {
        throw new Error('no window')
      }
      return { id: '1', ok: true, result: result([hit(OPEN)]), _meta: { runtimeId: 'r' } }
    })
    const printed = await run({ call } as unknown as RuntimeClient)
    expect(printed.result.hits[0].ref).toBe(`claude:${OPEN}@local`)
    expect(printed.result.hits[0].sidebar).toBeUndefined()
    expect(printed.result.sidebarJoin.reason).toContain('no window')
  })
})
