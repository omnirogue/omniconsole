import {
  appendFileSync,
  copyFileSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionSearchIndex } from './session-search-index'
import { SessionSearchIndexer } from './session-search-indexer'
import { listTranscriptFiles, type TranscriptRoot } from './session-search-roots'

const ID = '01a0e47e-85b2-7b72-b19d-fc991b299395'
const NAME = `rollout-2026-09-27T16-11-32-${ID}.jsonl`

function turn(text: string, minute: number): string {
  const timestamp = new Date(Date.UTC(2026, 8, 27, 16, minute)).toISOString()
  const payload = { type: 'message', role: 'user', content: [{ type: 'input_text', text }] }
  return `${JSON.stringify({ type: 'response_item', timestamp, payload })}\n`
}

let dir: string
let index: SessionSearchIndex
let indexer: SessionSearchIndexer
let roots: TranscriptRoot[]

function home(name: string): string {
  const sessions = join(dir, name, 'sessions', '2026', '09', '27')
  mkdirSync(sessions, { recursive: true })
  return join(sessions, NAME)
}

async function indexPass(): Promise<string[]> {
  const outcomes: string[] = []
  index.writes.begin()
  for (const file of await listTranscriptFiles(roots)) {
    outcomes.push(await indexer.indexFile(file))
  }
  index.writes.end()
  return outcomes
}

/** Makes `path` the newest copy regardless of filesystem timestamp resolution. */
function newer(path: string): void {
  const later = new Date(Date.now() + 60_000)
  utimesSync(path, later, later)
}

const seq = (): number => index.sessionByKey(`codex:${ID}`)!.nextSeq

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'session-search-aliases-'))
  index = new SessionSearchIndex(join(dir, 'index.sqlite'))
  indexer = new SessionSearchIndexer(index, null, { dutyCycle: 1, sleep: async () => undefined })
  roots = ['a', 'b', 'c'].map((name) => ({ agent: 'codex', dir: join(dir, name, 'sessions') }))
  writeFileSync(home('a'), turn('first ask about zebra budgets', 1) + turn('second ask', 2))
})

afterEach(() => {
  index.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('session search transcript aliases', () => {
  it('lists hardlinks of one rollout once, with every alias', async () => {
    linkSync(home('a'), home('b'))
    const files = await listTranscriptFiles(roots)
    expect(files).toHaveLength(1)
    expect([...(files[0]!.aliases ?? [])].sort()).toEqual([home('a'), home('b')].sort())
  })

  it('never re-indexes a session when its rollout is bridged into another home', async () => {
    renameSync(home('a'), home('b'))
    expect(await indexPass()).toEqual(['indexed'])
    const indexed = seq()
    // The bridge links it into a home listed first; that alias used to reset the whole session.
    linkSync(home('b'), home('a'))
    expect(await indexPass()).toEqual(['unchanged'])
    appendFileSync(home('a'), turn('third ask', 3))
    expect(await indexPass()).toEqual(['indexed'])
    expect(seq()).toBe(indexed + 1)
  })

  it('continues from the indexed offset when a copy extends the transcript', async () => {
    await indexPass()
    const indexed = seq()
    copyFileSync(home('a'), home('b'))
    appendFileSync(home('b'), turn('asked after the account switch', 3))
    newer(home('b'))
    expect(await indexPass()).toEqual(['indexed'])
    expect(seq()).toBe(indexed + 1)
  })

  it('re-indexes from the start when a newer copy does not continue the transcript', async () => {
    await indexPass()
    writeFileSync(home('b'), turn('an unrelated history of the same id', 5).repeat(3))
    newer(home('b'))
    expect(await indexPass()).toEqual(['reset'])
    expect(index.termCounts('zebra')).toEqual([])
    expect(index.termCounts('unrelated')).toHaveLength(1)
  })

  it('keeps a batch when one unit of work inside it fails', () => {
    index.writes.begin()
    index.ensureSession({ sessionKey: 'codex:kept', agent: 'codex', sessionId: 'kept', path: '/k' })
    expect(() =>
      index.transaction(() => {
        index.ensureSession({ sessionKey: 'codex:lost', agent: 'codex', sessionId: 'lost', path: '/l' })
        throw new Error('boom')
      })
    ).toThrow('boom')
    index.writes.end()
    expect(index.sessionByKey('codex:kept')).not.toBeNull()
    expect(index.sessionByKey('codex:lost')).toBeNull()
  })

  it('still sees appends and new aliases on later passes with cached listings', async () => {
    const a = home('a')
    writeFileSync(a, turn('first', 0))
    linkSync(a, home('b'))
    await listTranscriptFiles(roots)
    appendFileSync(a, turn('second', 1))
    const [file] = await listTranscriptFiles(roots)
    expect(file!.size).toBe(Buffer.byteLength(turn('first', 0) + turn('second', 1)))
    expect(file!.aliases).toHaveLength(2)
    linkSync(a, home('c'))
    expect((await listTranscriptFiles(roots))[0]!.aliases).toHaveLength(3)
  })
})
