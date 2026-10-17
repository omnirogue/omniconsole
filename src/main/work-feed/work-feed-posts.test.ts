import { describe, expect, it } from 'vitest'
import type { SessionSearchFeedRow } from '../session-search/session-search-service-protocol'
import { codexOrigin } from '../session-search/transcript-origin'
import {
  buildWorkFeedPosts,
  isWorkFeedSession,
  workFeedFingerprint,
  workFeedPostKey,
  workFeedWorkerMarkers
} from './work-feed-posts'

const row = (overrides: Partial<SessionSearchFeedRow> = {}): SessionSearchFeedRow => ({
  sessionKey: 'claude:aaaaaaaa-1111-2222-3333-444444444444',
  agent: 'claude',
  sessionId: 'aaaaaaaa-1111-2222-3333-444444444444',
  title: 'Pricing go-live',
  cwd: '/Users/maintainer/Work/OmniRogue/Marketing',
  firstTs: 1_790_000_000_000,
  lastTs: 1_790_000_600_000,
  userTurns: 6,
  textBytes: 40_000,
  firstAsk: 'Ship the Lifetime plan cards on both brands',
  lastAnswer: 'Opened both PRs.',
  links: ['https://github.com/omnirogue/omnirogue/pull/1020'],
  summary: 'Goal: ship\nDone: opened PRs\nState: Waiting on Sal\nNext: merge',
  summarySource: 'model',
  origin: { headless: false, parentSessionId: null },
  ...overrides
})

describe('which sessions are Work feed posts', () => {
  it('posts a session a person worked in', () => {
    expect(isWorkFeedSession(row())).toBe(true)
    // A native chat is an SDK session too, but a person asked more than once.
    expect(isWorkFeedSession(row({ origin: { headless: true, parentSessionId: null } }))).toBe(true)
  })

  it('leaves out helper runs, probes, routines, one-shot headless runs and empty openers', () => {
    const helperDir = '/Users/maintainer/Library/Application Support/OmniConsole'
    for (const skipped of [
      row({ cwd: `${helperDir}/session-search/summarizer` }),
      row({ cwd: '/data/omni/helpers', firstAsk: 'Plan the thing' }),
      row({ firstAsk: 'You write the search summary for one agent work session.', userTurns: 1 }),
      row({ firstAsk: 'Reply with exactly this one line and do nothing else: OK' }),
      row({
        firstAsk: 'ADVERTISING ROUTINE — OmniRogue + BetaCorp, every 30 minutes. Local routine.'
      }),
      row({ firstAsk: 'Routine definition context: Required output format: markdown.' }),
      row({ firstAsk: '<scheduled-task name="cs-recovery-daily-digest" file="x">' }),
      row({
        firstAsk:
          'You are working inside OmniConsole, a multi-agent IDE. You are a dispatched worker. Your coordinator…'
      }),
      row({ origin: { headless: true, parentSessionId: null }, userTurns: 1 }),
      row({ firstAsk: 'ok', userTurns: 1, textBytes: 300 }),
      row({ userTurns: 0 }),
      row({ lastTs: null })
    ]) {
      expect(isWorkFeedSession(skipped, ['/data/omni'])).toBe(false)
    }
    // A short opener that became real work stays.
    expect(isWorkFeedSession(row({ firstAsk: 'ok', userTurns: 1, textBytes: 90_000 }))).toBe(true)
  })

  it('folds a Codex worker into the session that spawned it', () => {
    const parentId = '01a0c107-10bd-7ce0-8bb0-27daddf4fe8b'
    const parent = row({ agent: 'codex', sessionId: parentId, sessionKey: `codex:${parentId}` })
    const worker = (n: number) =>
      row({
        agent: 'codex',
        sessionId: `01a0c385-2323-7710-a738-51657375053${n}`,
        sessionKey: `codex:w${n}`,
        origin: { headless: true, parentSessionId: parentId }
      })
    const posts = buildWorkFeedPosts([parent, worker(1), worker(2)], 'mac-studio')
    expect(posts).toHaveLength(1)
    expect(posts[0]).toMatchObject({
      session_id: parentId,
      workers: 2,
      host: 'mac-studio',
      agent: 'codex'
    })
  })

  it.each([2, 120])('does not publish a guardian with %i indexed user turns', (userTurns) => {
    const origin = codexOrigin(
      JSON.stringify({
        type: 'session_meta',
        payload: { source: { subagent: { other: 'guardian' } } }
      })
    )
    const guardian = row({
      agent: 'codex',
      sessionId: 'guardian-session',
      sessionKey: 'codex:guardian-session',
      firstAsk: 'The following is the Codex agent history whose request action you are assessing.',
      userTurns,
      origin
    })
    expect(isWorkFeedSession(guardian)).toBe(false)
    expect(buildWorkFeedPosts([row(), guardian], 'mac-studio')).toEqual([
      expect.objectContaining({ session_id: row().sessionId })
    ])
  })

  it('marks explicit workers without classifying a native SDK chat as a worker', () => {
    const worker = row({ origin: { headless: true, parentSessionId: 'parent-session' } })
    const nativeChat = row({
      sessionId: 'native-chat',
      origin: { headless: true, parentSessionId: null }
    })
    expect(workFeedWorkerMarkers([nativeChat, worker])).toEqual([
      { agent: worker.agent, session_id: worker.sessionId, source_kind: 'internal_worker' }
    ])
  })

  it('removes secret shapes before a post leaves the computer', () => {
    const [post] = buildWorkFeedPosts(
      [row({ firstAsk: 'use key sk-ant-api03-EXAMPLEEXAMPLEEXAMPLEEXAMPLE0000 for the test' })],
      'mac'
    )
    expect(post!.first_ask).not.toContain('EXAMPLEEXAMPLE')
  })

  it('sends a post again only when what it says changed', () => {
    const [post] = buildWorkFeedPosts([row()], 'mac')
    const [same] = buildWorkFeedPosts([row()], 'mac')
    const [summarized] = buildWorkFeedPosts(
      [row({ summary: 'Goal: ship\nState: Finished' })],
      'mac'
    )
    expect(workFeedFingerprint(post!)).toBe(workFeedFingerprint(same!))
    expect(workFeedFingerprint(post!)).not.toBe(workFeedFingerprint(summarized!))
    expect(workFeedPostKey(post!)).toBe('claude:aaaaaaaa-1111-2222-3333-444444444444')
  })
})
