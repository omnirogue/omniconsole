import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GraphJevStore } from '../graph/graph-jev-store'
import { WorkflowCacheMissError } from '../workflow-cache-miss'
import { createAuditEvidenceReader } from './audit-source-store'
import { createAuditJudgementObserver } from './audit-host'
import * as sources from './audit-snapshot'
import * as judgements from './audit-judgements'
import type { AuditSnapshot } from './audit-snapshot'

const roots: string[] = []
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'audit-cache-record-'))
  roots.push(root)
  const file = join(root, 'sources.jsonl')
  writeFileSync(
    file,
    JSON.stringify({ id: 'S1', timestamp: '2026-10-02T12:00:00Z', text: 'Evidence.' })
  )
  const audit = {
    version: 1,
    ...sources.captureAuditCorpus(file, 'sources-jsonl')
  } as AuditSnapshot
  const cache = join(root, 'cache.json')
  return { audit, cache, store: new GraphJevStore(cache) }
}
afterEach(() => {
  vi.restoreAllMocks()
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})
const citations = [{ sourceId: 'S1', quote: 'Evidence.' }]
const request: judgements.AuditJudgementRequest = {
  callId: 'audit/theme-judgements',
  findings: [],
  verifiedSourceIds: [],
  pairs: []
}
const corruptions = [
  ['null record', () => null],
  ['wrong digest', (record: Record<string, unknown>) => ({ ...record, digest: 'wrong' })],
  ['missing outcome', (record: Record<string, unknown>) => ({ ...record, outcome: null })],
  [
    'failed outcome',
    (record: Record<string, unknown>) => ({ ...record, outcome: { failed: true } })
  ],
  ['missing value', (record: Record<string, unknown>) => ({ ...record, outcome: {} })],
  ['invalid receipt time', (record: Record<string, unknown>) => ({ ...record, at: -1 })]
] as const

describe('audit cache envelope integrity', () => {
  it.each(corruptions)('does not reopen sources or overwrite %s', async (_name, corrupt) => {
    const { audit, cache, store } = fixture()
    await createAuditEvidenceReader(audit, store)(citations)
    const [id, record] = Object.entries(store.all())[0]
    const content = JSON.stringify({ [id]: corrupt(record) })
    writeFileSync(cache, content)
    const read = vi.spyOn(sources, 'readAuditSources')
    const write = vi.spyOn(store, 'write')
    for (const replay of [false, true]) {
      await expect(createAuditEvidenceReader(audit, store, replay)(citations)).rejects.toThrow(
        'Invalid audit cache record'
      )
    }
    expect(read).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
  })

  it.each(corruptions)('does not re-observe or overwrite %s', async (_name, corrupt) => {
    const { cache, store } = fixture()
    await createAuditJudgementObserver(store, false)(request)
    const record = store.read(request.callId)!
    writeFileSync(cache, JSON.stringify({ [request.callId]: corrupt(record) }))
    const observe = vi.spyOn(judgements, 'observeAuditJudgements')
    const write = vi.spyOn(store, 'write')
    for (const replay of [false, true]) {
      await expect(createAuditJudgementObserver(store, replay)(request)).rejects.toThrow(
        'Invalid audit cache record'
      )
    }
    expect(observe).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
  })

  it('distinguishes an absent fact from a corrupt present fact during recovery', async () => {
    const { audit, store } = fixture()
    await expect(createAuditEvidenceReader(audit, store, true)(citations)).rejects.toBeInstanceOf(
      WorkflowCacheMissError
    )
    await expect(createAuditJudgementObserver(store, true)(request)).rejects.toBeInstanceOf(
      WorkflowCacheMissError
    )
  })

  it('refuses changed judgement inputs under a previously recorded call ID', async () => {
    const { store } = fixture()
    const observe = createAuditJudgementObserver(store, false)
    await observe(request)
    const provider = vi.spyOn(judgements, 'observeAuditJudgements')
    await expect(observe({ ...request, rankThemes: false })).rejects.toThrow(
      'Invalid audit cache record'
    )
    expect(provider).not.toHaveBeenCalled()
  })
})
