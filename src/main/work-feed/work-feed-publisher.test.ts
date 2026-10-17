import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { SessionSearchFeedRow } from '../session-search/session-search-service-protocol'
import type { SessionSearchService } from '../session-search/session-search-service'
import type { WorkFeedPublication } from './work-feed-posts'
import { requestConsoleWorkflow } from '../backoffice/console-workflow-transport'
import {
  runWorkFeedRound,
  sendWorkFeedPosts,
  WORK_FEED_WINDOW_MS,
  type WorkFeedSendResult
} from './work-feed-publisher'

vi.mock('../backoffice/console-workflow-transport', () => ({ requestConsoleWorkflow: vi.fn() }))
vi.mock('../session-ledger/ledger-client', () => ({
  currentLedgerPrincipal: () => 'user_sal',
  unavailableReason: () => 'unavailable'
}))

const NOW = 1_790_400_000_000

function row(n: number, overrides: Partial<SessionSearchFeedRow> = {}): SessionSearchFeedRow {
  const id = `aaaaaaaa-1111-2222-3333-${String(n).padStart(12, '0')}`
  return {
    sessionKey: `claude:${id}`,
    agent: 'claude',
    sessionId: id,
    title: `Session ${n}`,
    cwd: '/Users/maintainer/Work/OmniRogue/Marketing',
    firstTs: NOW - 3_600_000,
    lastTs: NOW - n * 60_000,
    userTurns: 4,
    textBytes: 20_000,
    firstAsk: `Do task number ${n} properly`,
    lastAnswer: 'Done.',
    links: [],
    summary: 'Goal: x\nState: Finished',
    summarySource: 'model',
    origin: { headless: false, parentSessionId: null },
    ...overrides
  }
}

function setup(rows: SessionSearchFeedRow[]) {
  const userDataPath = mkdtempSync(join(tmpdir(), 'work-feed-'))
  const feedRows = vi.fn(async () => rows)
  const service = { feedRows } as unknown as SessionSearchService
  const sent: WorkFeedPublication[][] = []
  let answer: WorkFeedSendResult = { ok: true, rejected: [] }
  let principal: string | null = 'user_sal'
  const deps = {
    service: () => service,
    userDataPath,
    host: 'mac-studio',
    principal: () => principal,
    now: () => NOW,
    send: async (posts: WorkFeedPublication[]) => {
      sent.push(posts)
      return answer
    }
  }
  return {
    deps,
    sent,
    feedRows,
    answer: (next: WorkFeedSendResult) => (answer = next),
    signIn: (next: string | null) => (principal = next)
  }
}

describe('the Work feed publisher', () => {
  it('backfills the last eight days once, in batches, then sends only what changed', async () => {
    const rows = Array.from({ length: 60 }, (_, n) => row(n + 1))
    const feed = setup(rows)
    expect(await runWorkFeedRound(feed.deps)).toBe(60)
    expect(feed.feedRows).toHaveBeenCalledWith({
      sinceMs: NOW - WORK_FEED_WINDOW_MS,
      limit: 10_000
    })
    expect(feed.sent.map((batch) => batch.length)).toEqual([50, 10])
    expect(feed.sent[0]![0]).toMatchObject({ session_id: rows[0]!.sessionId, host: 'mac-studio' })
    expect(await runWorkFeedRound(feed.deps)).toBe(0)
    rows[5] = { ...rows[5]!, summary: 'Goal: x\nState: Waiting on Uma' }
    expect(await runWorkFeedRound(feed.deps)).toBe(1)
    expect(feed.sent.at(-1)!.map((post) => post.session_id)).toEqual([rows[5]!.sessionId])
  })

  it('sends nothing while signed out and starts over for a different person', async () => {
    const feed = setup([row(1)])
    feed.signIn(null)
    expect(await runWorkFeedRound(feed.deps)).toBe(0)
    expect(feed.sent).toEqual([])
    feed.signIn('user_sal')
    expect(await runWorkFeedRound(feed.deps)).toBe(1)
    feed.signIn('user_uma')
    expect(await runWorkFeedRound(feed.deps)).toBe(1)
  })

  it('retries a batch the console could not take, but not one it refused', async () => {
    const feed = setup([row(1), row(2)])
    feed.answer({ ok: false, reason: 'offline' })
    expect(await runWorkFeedRound(feed.deps)).toBe(0)
    feed.answer({ ok: true, rejected: [1] })
    expect(await runWorkFeedRound(feed.deps)).toBe(1)
    expect(await runWorkFeedRound(feed.deps)).toBe(0)
    expect(feed.sent).toHaveLength(2)
  })

  it('repeats identity-only worker markers even when no visible post changes', async () => {
    const worker = row(2, { origin: { headless: true, parentSessionId: null, worker: true } })
    const feed = setup([row(1), worker])
    const marker = {
      agent: worker.agent,
      session_id: worker.sessionId,
      source_kind: 'internal_worker'
    }
    expect(await runWorkFeedRound(feed.deps)).toBe(2)
    expect(feed.sent[0]).toEqual([expect.objectContaining({ title: 'Session 1' }), marker])
    expect(await runWorkFeedRound(feed.deps)).toBe(1)
    expect(feed.sent[1]).toEqual([marker])
  })

  it('retries a worker-only batch after offline or an older server refuses it', async () => {
    const worker = row(1, { origin: { headless: true, parentSessionId: null, worker: true } })
    const feed = setup([worker])
    feed.answer({ ok: false, reason: 'offline' })
    expect(await runWorkFeedRound(feed.deps)).toBe(0)
    feed.answer({ ok: true, rejected: [0] })
    expect(await runWorkFeedRound(feed.deps)).toBe(0)
    feed.answer({ ok: true, rejected: [] })
    expect(await runWorkFeedRound(feed.deps)).toBe(1)
    expect(feed.sent).toHaveLength(3)
    expect(feed.sent.every((batch) => batch[0]?.source_kind === 'internal_worker')).toBe(true)
  })

  it('uses the existing authenticated publish endpoint for a marker-only batch', async () => {
    const marker = {
      agent: 'codex' as const,
      session_id: row(1).sessionId,
      source_kind: 'internal_worker' as const
    }
    vi.mocked(requestConsoleWorkflow).mockResolvedValueOnce({
      ok: true,
      data: { accepted: 1, rejected: [] }
    })
    expect(await sendWorkFeedPosts([marker], 'user_sal')).toEqual({ ok: true, rejected: [] })
    expect(requestConsoleWorkflow).toHaveBeenLastCalledWith(
      '/api/team-feed/work-posts',
      'POST',
      expect.anything(),
      { posts: [marker] },
      20_000,
      false,
      'user_sal',
      expect.any(Function)
    )
  })
})
