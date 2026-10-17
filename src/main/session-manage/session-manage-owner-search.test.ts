import { describe, expect, it, vi } from 'vitest'
import type { SessionSearchHit } from '../../shared/session-search-types'
import { sessionOwnerOverlap, sessionOwnerTaskFiles } from './session-manage-owner-files'
import {
  buildSessionOwnerJevRequest,
  buildSessionOwnerSwappedRequest,
  judgeSessionOwner
} from './session-manage-owner-jev'
import { joinSessionSearchHitsToRows } from './session-manage-owner-search'
import { sidebarRow } from './session-manage-test-fixtures'

function hit(sessionId: string, cwd: string | null, executionHostId = 'local'): SessionSearchHit {
  return {
    sessionKey: `claude:${sessionId}`,
    sessionId,
    agent: 'claude',
    hostLabel: 'mac',
    executionHostId,
    title: sessionId,
    cwd,
    transcriptPath: `/t/${sessionId}.jsonl`,
    lastActivityAt: null,
    score: 1,
    reasons: [],
    snippets: [],
    summary: null,
    summarySource: null
  }
}

describe('joinSessionSearchHitsToRows', () => {
  const rows = [
    sidebarRow({ paneKey: 'tab-1:leaf-1', tabId: 'tab-1', worktreePath: '/w' }),
    sidebarRow({ paneKey: 'tab-2:leaf-1', tabId: 'tab-2', worktreePath: '/v' }),
    sidebarRow({ paneKey: 'tab-3:leaf-1', tabId: 'tab-3', worktreePath: '/r', hostId: 'ssh:box' })
  ]
  const ids: Record<string, string> = { 'tab-1:leaf-1': 'claude-a' }

  it('joins by the provider session id, and by path only for rows with no known id', () => {
    const joined = joinSessionSearchHitsToRows(
      [hit('claude-a', '/elsewhere'), hit('claude-old', '/w'), hit('claude-b', '/v')],
      rows,
      (paneKey) => ids[paneKey] ?? null
    )
    expect(joined.map((entry) => entry.paneKey)).toEqual([
      'tab-1:leaf-1',
      undefined,
      'tab-2:leaf-1'
    ])
    expect(joined[2]).toMatchObject({ tabId: 'tab-2' })
  })

  it('never joins a remote hit or a remote row', () => {
    const joined = joinSessionSearchHitsToRows(
      [hit('claude-c', '/r'), hit('claude-a', '/w', 'runtime:env')],
      rows,
      (paneKey) => ids[paneKey] ?? null
    )
    expect(joined.map((entry) => entry.paneKey)).toEqual([undefined, undefined])
  })
})

describe('session find-owner JEV', () => {
  const session = {
    title: 'Ads fetcher',
    goal: 'Build the Meta ads report fetcher',
    summary: 'x'.repeat(5_000)
  }

  it('asks continuation and duplicate with the task first, then duplicate swapped', () => {
    const first = buildSessionOwnerJevRequest('Add retry to the fetcher', session)
    const swapped = buildSessionOwnerSwappedRequest('Add retry to the fetcher', session)
    expect(first.capability).toBe('sessions.find-owner')
    expect(Object.keys(first.questions)).toEqual(['continuation', 'duplicate'])
    expect(Object.keys(swapped.questions)).toEqual(['duplicate'])
    const state = first.state as Record<string, string>
    const reversed = swapped.state as Record<string, string>
    expect(state.first).toBe('Add retry to the fetcher')
    expect(state.second).toContain(
      "Goal (the person's first request to it): Build the Meta ads report fetcher"
    )
    expect(state.second!.length).toBeLessThan(1_400)
    expect(reversed).toEqual({ first: state.second, second: state.first })
  })

  it('keeps the lower duplicate reading of the two orders, and null when one is missing', async () => {
    const answers = (continuation: number | null, duplicate: number | null) => ({
      provider: 'test',
      model: 'test',
      answers: {
        ...(continuation === null ? {} : { continuation: { type: 'noul', noul: continuation } }),
        ...(duplicate === null ? {} : { duplicate: { type: 'noul', noul: duplicate } })
      }
    })
    const evaluate = vi
      .fn()
      .mockResolvedValueOnce(answers(0.9, 0.95))
      .mockResolvedValueOnce(answers(null, 0.6))
    const options = { evaluate, credential: async () => 'key', environment: {} }
    await expect(judgeSessionOwner('task', session, options)).resolves.toEqual({
      related: 0.9,
      duplicate: 0.6
    })
    evaluate.mockResolvedValueOnce(answers(0.9, 0.95)).mockRejectedValueOnce(new Error('down'))
    await expect(judgeSessionOwner('task', session, options)).resolves.toEqual({
      related: 0.9,
      duplicate: null
    })
  })
})

describe('task files', () => {
  it('reads paths, file names and globs from the task, plus --files', () => {
    expect(
      sessionOwnerTaskFiles(
        'Fix `src/auth/login.ts:42`, update README.md and src/**/*.test.ts (not and/or, v1.2 or https://x.io/a/b).',
        ['docs/guide']
      )
    ).toEqual(['src/auth/login.ts', 'README.md', 'src/**/*.test.ts', 'docs/guide'])
  })

  it('covers a changed file by exact path, file name, directory or glob, inside the worktree', () => {
    const changed = ['src/auth/login.ts', 'src/auth/session.ts', 'docs/guide/intro.md', 'a.txt']
    expect(sessionOwnerOverlap(['login.ts'], changed, '/w')).toEqual(['src/auth/login.ts'])
    expect(sessionOwnerOverlap(['docs/guide'], changed, '/w')).toEqual(['docs/guide/intro.md'])
    expect(sessionOwnerOverlap(['src/auth/*.ts'], changed, '/w')).toEqual([
      'src/auth/login.ts',
      'src/auth/session.ts'
    ])
    expect(sessionOwnerOverlap(['/w/a.txt'], changed, '/w')).toEqual(['a.txt'])
    expect(sessionOwnerOverlap(['/other/a.txt'], changed, '/w')).toEqual([])
  })
})
