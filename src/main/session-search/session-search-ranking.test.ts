import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionSearchIndex } from './session-search-index'
import { SessionSearchIndexer } from './session-search-indexer'
import { planSessionSearchQuery } from './session-search-query'
import { rankSessions } from './session-search-ranking'
import { transcriptSessionId, type TranscriptFile } from './session-search-roots'

const IDS = {
  handoff: '86065e26-81d3-4d4e-baf9-ea60024bf694',
  ads: '11111111-2222-4333-8444-555555555555',
  sidecar: '99999999-2222-4333-8444-555555555555'
}

function turn(type: 'user' | 'assistant', text: string, minute: number): string {
  const content = type === 'user' ? text : [{ type: 'text', text }]
  const timestamp = new Date(Date.UTC(2026, 8, 24, 10, minute)).toISOString()
  return `${JSON.stringify({ type, timestamp, cwd: '/w', message: { content } })}\n`
}

let dir: string
let index: SessionSearchIndex
let indexer: SessionSearchIndexer

function file(id: string): TranscriptFile {
  const path = join(dir, `${id}.jsonl`)
  const info = statSync(path)
  return {
    agent: 'claude',
    path,
    sessionId: transcriptSessionId(path),
    size: info.size,
    mtimeMs: info.mtimeMs
  }
}

function search(query: string): string[] {
  return rankSessions(index, planSessionSearchQuery(query), {
    limit: 10,
    now: Date.UTC(2026, 8, 24, 12),
    model: null,
    embeddings: new Map(),
    queryText: query
  }).map((entry) => entry.session.sessionId)
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'session-search-'))
  index = new SessionSearchIndex(join(dir, 'index.sqlite'))
  indexer = new SessionSearchIndexer(index, null, { dutyCycle: 1, sleep: async () => undefined })
  const title = JSON.stringify({
    type: 'custom-title',
    customTitle: 'OmniRogue side menu — simplify (draft PR)'
  })
  writeFileSync(
    join(dir, `${IDS.handoff}.jsonl`),
    [
      `${title}\n`,
      turn('user', 'Simplify the OmniRogue side menu and open a draft PR', 1),
      turn('assistant', 'Opened https://github.com/omnirogue/omnirogue/pull/1116', 2),
      turn('user', 'ok can you make a handoff for uma to fix the failing CIs', 3),
      turn(
        'assistant',
        'The handoff is at https://app.omnisi.ai/a/1a0d42a7df36eefc2 and prod-omnirogue deploys keep failing CI. OPENAI_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz0123456789',
        4
      )
    ].join('')
  )
  writeFileSync(
    join(dir, `${IDS.ads}.jsonl`),
    [
      turn('user', 'Report OmniRogue ad spend for the week', 1),
      turn(
        'assistant',
        'OmniRogue spend is up this week across every ad account. Separately, production traffic was normal.',
        2
      )
    ].join('')
  )
  writeFileSync(
    join(dir, `${IDS.sidecar}.jsonl`),
    turn(
      'user',
      'You suggest what the person should ask Claude to do next, after its turn finished. Uma handoff prod-omnirogue https://app.omnisi.ai/a/1a0d42a7df36eefc2',
      1
    )
  )
  for (const id of Object.values(IDS)) {
    await indexer.indexFile(file(id))
  }
})

afterEach(() => {
  index.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('session search ranking', () => {
  it('finds the session by a name, a review-page URL and a paraphrase of its branch', () => {
    expect(search('Uma')[0]).toBe(IDS.handoff)
    expect(search('https://app.omnisi.ai/a/1a0d42a7df36eefc2')).toEqual([IDS.handoff])
    expect(search('omnirogue production')[0]).toBe(IDS.handoff)
  })

  it('never returns OmniConsole helper runs that quote other sessions', () => {
    expect(search('Uma')).not.toContain(IDS.sidecar)
  })

  it('explains each match', () => {
    const [top] = rankSessions(index, planSessionSearchQuery('omnirogue production'), {
      limit: 1,
      now: Date.UTC(2026, 8, 24, 12),
      model: null,
      embeddings: new Map(),
      queryText: 'omnirogue production'
    })
    expect(top!.reasons[0]).toMatch(/together in 1 message/)
    expect(top!.snippets[0]!.text).toContain('\u0002')
  })

  it('stores no secrets and keeps the summary current', () => {
    const session = index.sessionByKey(`claude:${IDS.handoff}`)!
    expect(
      index
        .conversationTurns(session.sid)
        .map((entry) => entry.text)
        .join(' ')
    ).not.toContain('sk-proj-')
    expect(session.summary).toContain('https://app.omnisi.ai/a/1a0d42a7df36eefc2')
    expect(session.summarySource).toBe('extractive')
  })

  it('indexes only what was appended since the last pass', async () => {
    const before = index.sessionByKey(`claude:${IDS.ads}`)!.nextSeq
    appendFileSync(join(dir, `${IDS.ads}.jsonl`), turn('user', 'Now pause the Kowboy campaign', 3))
    expect(await indexer.indexFile(file(IDS.ads))).toBe('indexed')
    expect(index.sessionByKey(`claude:${IDS.ads}`)!.nextSeq).toBe(before + 1)
    expect(search('kowboy')).toEqual([IDS.ads])
    expect(await indexer.indexFile(file(IDS.ads))).toBe('unchanged')
  })

  it('matches tool output without storing it, and forgets it when the file is rewritten', async () => {
    const path = join(dir, `${IDS.ads}.jsonl`)
    const output = { type: 'tool_result', content: 'created https://github.com/o/r/pull/4242' }
    appendFileSync(path, `${JSON.stringify({ type: 'user', message: { content: [output] } })}\n`)
    await indexer.indexFile(file(IDS.ads))
    expect(search('pull/4242')).toEqual([IDS.ads])
    writeFileSync(path, turn('user', 'short again', 1))
    expect(await indexer.indexFile(file(IDS.ads))).toBe('reset')
    expect(search('pull/4242')).toEqual([])
  })

  it('does not index a line until it is complete', async () => {
    const path = join(dir, `${IDS.ads}.jsonl`)
    appendFileSync(path, turn('user', 'half written zebra', 4).slice(0, 40))
    await indexer.indexFile(file(IDS.ads))
    expect(search('zebra')).toEqual([])
    appendFileSync(path, turn('user', 'half written zebra', 4).slice(40))
    await indexer.indexFile(file(IDS.ads))
    expect(search('zebra')).toEqual([IDS.ads])
  })
})
