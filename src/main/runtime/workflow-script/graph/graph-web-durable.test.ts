import { fsyncSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebPageReading } from '../../../web-pages/web-page-reader'
import { GraphJevStore } from './graph-jev-store'
import type { GraphCall } from './graph-plan-types'
import type { GraphWebReader } from './graph-web-pages'
import {
  createGraphWebSources,
  GraphWebChangedError,
  graphWebReadersStarted
} from './graph-web-sources'
import { GraphWebStore } from './graph-web-store'
import { webResearch } from './graph-web-test-fixtures'
import { GRAPH_WEB_SEAT_ID, WEB_RULES } from './graph-web-types'

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<{ fsyncSync: (handle: number) => void }>()
  return { ...fs, fsyncSync: vi.fn(fs.fsyncSync) }
})

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
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'graph-web-durable-'))
  vi.mocked(fsyncSync).mockClear()
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const stores = () => ({
  store: GraphJevStore.forExecution('run-1', dir, 'web-sources.json'),
  calls: GraphJevStore.forExecution('run-1', dir, 'web-calls.json'),
  blobs: GraphWebStore.forExecution('run-1', dir)
})

describe('the web call’s start marker', () => {
  it('is on disk, file and folders synced, before any page is read', async () => {
    const seen: { syncs: number; marker: unknown }[] = []
    const read = vi.fn<GraphWebReader>(async () => {
      seen.push({
        syncs: vi.mocked(fsyncSync).mock.calls.length,
        marker: stores().calls.read(WEB.id)?.outcome
      })
      return page
    })
    await createGraphWebSources({ ...stores(), read })(WEB)
    // The file, its folder and the new run folder's parent; Windows can only sync the file.
    expect(seen).toEqual([
      { syncs: process.platform === 'win32' ? 1 : 3, marker: { value: 'started' } }
    ])
    expect(stores().calls.read(WEB.id)?.outcome).toEqual({ value: 'kept' })
  })

  it('is backed by the checkpoint: a recorded reader call means the pages were kept', async () => {
    // Both files lost with the power, yet a reader already ran: never read the pages again.
    const read = vi.fn<GraphWebReader>(async () => page)
    for (const cacheOnly of [true, false]) {
      const answer = createGraphWebSources({
        ...stores(),
        read,
        cacheOnly,
        readersStarted: () => true
      })
      await expect(answer(WEB)).rejects.toBeInstanceOf(GraphWebChangedError)
    }
    expect(read).not.toHaveBeenCalled()
    const snapshot = { graph: { spec: webResearch([URL]) }, host: { webRules: WEB_RULES } }
    const started = (recorded: string[]) =>
      graphWebReadersStarted(snapshot, () => recorded).readersStarted!()
    expect(started(['research/a0'])).toBe(true)
    expect(started(['research/r2/a1'])).toBe(true)
    expect(started(['critics/a0', 'final/a0'])).toBe(false)
    expect(graphWebReadersStarted({ graph: snapshot.graph, host: {} }, () => [])).toEqual({})
  })
})
