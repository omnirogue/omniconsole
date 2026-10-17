import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionSearchIndex } from './session-search-index'
import { MODEL_SUMMARY_MAX_CHARS } from './session-summary-prompt'

describe('lastConversationTs', () => {
  it('is the newest ask or reply, not a later tool line, and null for an empty session', () => {
    const index = new SessionSearchIndex(
      join(mkdtempSync(join(tmpdir(), 'search-index-')), 'index.sqlite')
    )
    const session = index.ensureSession({
      sessionKey: 'claude:aaaaaaaa-1111-2222-3333-444444444444',
      agent: 'claude',
      sessionId: 'aaaaaaaa-1111-2222-3333-444444444444',
      path: '/tmp/a.jsonl'
    })
    expect(index.lastConversationTs(session.sid)).toBeNull()
    index.transaction(() =>
      index.appendChunks(session, [
        { role: 'user', text: 'ship the plan cards', ts: 1_000 },
        { role: 'assistant', text: 'opened both PRs', ts: 2_000 },
        { role: 'tool', text: 'restart restored this session', ts: 9_000 }
      ])
    )
    expect(index.lastConversationTs(session.sid)).toBe(2_000)
    index.close()
  })
})

describe('sessionsNeedingModelSummary', () => {
  it('refreshes cut or outdated summaries and backfills legacy titles once', () => {
    const index = new SessionSearchIndex(
      join(mkdtempSync(join(tmpdir(), 'search-index-')), 'index.sqlite')
    )
    const make = (n: number, summary: string, addedBytes = 0) => {
      const id = `aaaaaaaa-1111-2222-3333-${String(n).padStart(12, '0')}`
      const session = index.ensureSession({
        sessionKey: `claude:${id}`,
        agent: 'claude',
        sessionId: id,
        path: `/tmp/${n}.jsonl`
      })
      session.lastTs = 5_000 + n
      session.textBytes = 20_000
      index.saveSessionFacts(session)
      index.saveSummary(session, summary, 'model', null)
      session.textBytes += addedBytes
      index.saveSessionFacts(session)
      return session.sessionKey
    }
    const prefix = 'Title: Ship plan cards\nGoal: '
    const cut = `${prefix}${'g'.repeat(MODEL_SUMMARY_MAX_CHARS - prefix.length - 1)}…\nLinks: https://github.com/omnirogue/omni-ide/pull/1`
    const cutKey = make(1, cut)
    const current = 'Title: Ship plan cards\nGoal: ship\nDone: shipped\nState: Finished\nNext: none'
    make(2, current)
    make(3, 'Title: Ship plan cards\nGoal: ship\nDone: a short summary without a State line')
    const legacyKey = make(4, 'Goal: ship\nDone: shipped\nState: Finished\nNext: none')
    make(5, 'Title: unknown\nGoal: ship\nDone: shipped\nState: Finished')
    const quietKey = make(6, current, 13_000)
    const outdatedKey = make(7, current, 13_001)
    const picked = index.sessionsNeedingModelSummary({
      limit: 10,
      minBytes: 1_000,
      activeSince: 0
    })
    expect(picked.map((session) => session.sessionKey)).toEqual([outdatedKey, legacyKey, cutKey])

    index.saveSummary(index.sessionByKey(legacyKey)!, current, 'model', null)
    const afterBackfill = index.sessionsNeedingModelSummary({
      limit: 10,
      minBytes: 1_000,
      activeSince: 0
    })
    expect(afterBackfill.map((session) => session.sessionKey)).toEqual([outdatedKey, cutKey])
    const quiet = index.sessionsNeedingModelSummary({
      limit: 10,
      minBytes: 1_000,
      activeSince: 0,
      idleBefore: 5_006
    })
    expect(quiet.map((session) => session.sessionKey)).toEqual([outdatedKey, quietKey, cutKey])
    index.close()
  })
})
