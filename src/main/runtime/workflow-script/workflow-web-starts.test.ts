import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebPageReading } from '../../web-pages/web-page-reader'
import { OrchestrationDb } from '../orchestration/db'
import { SCHEMA_VERSION } from '../orchestration/db/contract-constants'
import { GraphJevStore } from './graph/graph-jev-store'
import type { GraphCall } from './graph/graph-plan-types'
import type { GraphWebReader } from './graph/graph-web-pages'
import { createGraphWebSources, GraphWebChangedError } from './graph/graph-web-sources'
import { GraphWebStore } from './graph/graph-web-store'
import { GRAPH_WEB_SEAT_ID, WEB_RULES } from './graph/graph-web-types'
import { WorkflowCheckpointStore } from './workflow-checkpoint-store'
import { workflowWebStarted } from './workflow-web-starts'

const URL = 'https://a.example/one'
const WEB: GraphCall = {
  id: 'research/web',
  prompt: '',
  schema: {},
  output: 'text',
  seatId: GRAPH_WEB_SEAT_ID,
  dependencies: [],
  stepId: 'research',
  round: 1,
  agentIndex: 5,
  web: { rules: WEB_RULES, sources: [{ id: 'W1', url: URL }] },
  validateSemantics: () => null
}
const page: WebPageReading = {
  state: 'read',
  text: 'Words.',
  title: '',
  finalUrl: URL,
  redirects: [],
  contentType: 'text/plain',
  bytes: 6,
  rawSha256: '',
  textSha256: '',
  removedLines: 0,
  truncated: false,
  raw: Buffer.from('Words.'),
  fetchedAt: '2026-09-24T10:12:00.000Z'
}

let dir = ''
const opened: OrchestrationDb[] = []
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'workflow-web-starts-'))
})
afterEach(() => {
  opened.splice(0).forEach((db) => db.close())
  rmSync(dir, { recursive: true, force: true })
})

function checkpoint(file = ':memory:', host: object = { webRules: WEB_RULES }, request = 'r') {
  const db = new OrchestrationDb(file)
  opened.push(db)
  const store = new WorkflowCheckpointStore(db.db)
  const executionId = store.create({
    conversationId: `conversation-${request}`,
    requestId: request,
    snapshot: { version: 1, seats: [], task: { prompt: 'Read', evidence: '' }, host },
    preset: 'council',
    fence: 1,
    attemptLimit: 3,
    callLimit: 3,
    budgetLimit: 9
  })
  return { db, store, executionId, starts: () => store.attempts.webStarts(executionId, 1) }
}

// Fresh files each time: what a Windows power loss can leave after the marker was written.
const files = (folder: string) => ({
  store: GraphJevStore.forExecution('run-1', folder, 'web-sources.json'),
  calls: GraphJevStore.forExecution('run-1', folder, 'web-calls.json'),
  blobs: GraphWebStore.forExecution('run-1', folder)
})

describe('the checkpoint\u2019s record of a web call that began', () => {
  it('is written, durably, before any page is fetched', async () => {
    const run = checkpoint()
    const levels: unknown[] = []
    const prepare = run.db.db.prepare.bind(run.db.db)
    vi.spyOn(run.db.db, 'prepare').mockImplementation((sql: string) => {
      if (sql.startsWith('INSERT OR REPLACE INTO local_workflow_web_starts')) {
        levels.push(run.db.db.pragma('synchronous', { simple: true }))
      }
      return prepare(sql)
    })
    const read = vi.fn<GraphWebReader>(async () => {
      // The fetch starts only once the row is there: a crash from here on can never re-read.
      expect(run.starts().has(WEB.id)).toBe(true)
      return page
    })
    await createGraphWebSources({ ...files(dir), starts: run.starts(), read })(WEB)
    expect(read).toHaveBeenCalledTimes(1)
    // FULL for that one commit (WAL with NORMAL does not survive power loss), then NORMAL again.
    expect(levels).toEqual([2])
    expect(run.db.db.pragma('synchronous', { simple: true })).toBe(1)
    expect(workflowWebStarted(run.db.db, run.executionId)).toBe(true)
  })

  it('holds the run when every web file is gone, and never fetches again', async () => {
    const run = checkpoint()
    await createGraphWebSources({ ...files(dir), starts: run.starts(), read: async () => page })(
      WEB
    )
    const read = vi.fn<GraphWebReader>(async () => page)
    const lost = mkdtempSync(join(tmpdir(), 'workflow-web-starts-lost-'))
    try {
      for (const cacheOnly of [false, true]) {
        await expect(
          createGraphWebSources({ ...files(lost), starts: run.starts(), read, cacheOnly })(WEB)
        ).rejects.toBeInstanceOf(GraphWebChangedError)
      }
    } finally {
      rmSync(lost, { recursive: true, force: true })
    }
    expect(read).not.toHaveBeenCalled()
  })

  it('is released when nothing was kept, so Retry may read again', async () => {
    const run = checkpoint()
    const failing: GraphWebReader = async () => ({
      state: 'unreadable',
      reason: { code: 'network' },
      redirects: []
    })
    await createGraphWebSources({ ...files(dir), starts: run.starts(), read: failing })(WEB)
    expect(run.starts().has(WEB.id)).toBe(false)
    const stop = new AbortController()
    const stopped = createGraphWebSources({
      ...files(dir),
      starts: run.starts(),
      signal: stop.signal,
      read: async () => {
        stop.abort()
        return page
      }
    })(WEB)
    await expect(stopped).rejects.toThrow()
    expect(run.starts().has(WEB.id)).toBe(false)
  })

  it('belongs to the fence that owns the run', () => {
    const run = checkpoint()
    expect(() => run.store.attempts.webStarts(run.executionId, 2).has(WEB.id)).toThrow(
      'Workflow ownership fence rejected'
    )
  })
})

describe('a v42 database that lost its record of web starts', () => {
  const reopen = (file: string, change: string) => {
    opened.splice(0).forEach((db) => db.close())
    const raw = new DatabaseSync(file)
    raw.exec(change)
    raw.close()
    const db = new OrchestrationDb(file)
    opened.push(db)
    return new WorkflowCheckpointStore(db.db)
  }

  it.each([
    ['the table is gone', 'DROP TABLE local_workflow_web_starts'],
    [
      'the table lost a column',
      'DROP TABLE local_workflow_web_starts; CREATE TABLE local_workflow_web_starts (execution_id TEXT, call_id TEXT)'
    ]
  ])('holds every web run for recovery when %s, and never reads again', async (_name, change) => {
    const file = join(dir, 'orchestration.db')
    const web = checkpoint(file)
    const plain = checkpoint(file, {}, 'plain')
    // Started before any reader call: the table was the only record, and it is lost.
    web.starts().begin(WEB.id, 'digest')
    const store = reopen(file, change)
    const starts = store.attempts.webStarts(web.executionId, 1)
    expect(starts.has(WEB.id)).toBe(true)
    expect(starts.has('other/web')).toBe(true)
    expect(store.attempts.webStarts(plain.executionId, 1).has(WEB.id)).toBe(false)
    const read = vi.fn<GraphWebReader>(async () => page)
    await expect(
      createGraphWebSources({ ...files(dir), starts, read })(WEB)
    ).rejects.toBeInstanceOf(GraphWebChangedError)
    expect(read).not.toHaveBeenCalled()
    // Releasing a call never clears the loss: only recovery may decide.
    starts.release(WEB.id)
    expect(starts.has(WEB.id)).toBe(true)
  })

  it('starts empty below v42, when no start was ever recorded there', () => {
    const file = join(dir, 'orchestration.db')
    const web = checkpoint(file)
    const store = reopen(file, 'DROP TABLE local_workflow_web_starts; PRAGMA user_version = 41')
    expect(store.attempts.webStarts(web.executionId, 1).has(WEB.id)).toBe(false)
  })
})

describe('the v42 schema', () => {
  it('creates the table, upgrades v41, and repairs a v42 that lost it', () => {
    const file = join(dir, 'orchestration.db')
    new OrchestrationDb(file).close()
    const count = (db: DatabaseSync) =>
      (
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='local_workflow_web_starts'"
          )
          .get() as { count: number }
      ).count
    for (const version of [41, 42]) {
      const raw = new DatabaseSync(file)
      raw.exec('DROP TABLE local_workflow_web_starts')
      raw.exec(`PRAGMA user_version = ${version}`)
      expect(count(raw)).toBe(0)
      raw.close()
      const upgraded = new OrchestrationDb(file)
      expect(upgraded.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
      upgraded.close()
      const inspect = new DatabaseSync(file)
      expect(count(inspect)).toBe(1)
      inspect.close()
    }
    expect(SCHEMA_VERSION).toBe(42)
  })
})
