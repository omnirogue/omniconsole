import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from '../../sqlite/sync-database'
import type { LocalWorkflowView } from '../../../shared/local-workflow-view'
import { workflowEvidenceDigest } from './workflow-evidence-digest'
import { readDiscoverStats } from './workflow-discover-stats'
import { projectLocalWorkflow } from './local-workflow-projection'
import { graphItemView } from './local-workflow-graph-item-view'
import { normalizeWorkflowSpec } from '../../../shared/workflow-graph-normalize'

vi.mock('./local-workflow-projection', () => ({ projectLocalWorkflow: vi.fn() }))
const roots: string[] = []
afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
  vi.clearAllMocks()
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'discover-stats-'))
  roots.push(root)
  const id = '00000000-0000-4000-8000-000000000001'
  const spec = normalizeWorkflowSpec({
    template: 'discover',
    steps: [
      {
        id: 'find',
        kind: 'do',
        title: 'Find',
        agents: [{ route: 'claude', angle: 'Safety' }],
        list: { maxItems: 10 }
      },
      {
        id: 'verify',
        kind: 'review',
        title: 'Verify',
        agents: [{ route: 'codex' }],
        inputs: ['find'],
        forEach: { step: 'find', limit: 10 }
      }
    ],
    repeat: { do: 'find', review: 'verify', until: 'nothing-new', maxRounds: 2 }
  })
  const source = graphItemView({
    key: 'find.r1.1',
    title: 'Claim',
    detail: 'Evidence from the source.',
    location: 'a.ts:1',
    severity: 'high',
    repeats: 0,
    round: 1,
    sourceCallId: 'find/r1/a0',
    alsoFrom: ['find/r1/a1']
  })
  const view: LocalWorkflowView = {
    executionId: id,
    fence: 1,
    sequence: 1,
    preset: 'discover',
    state: 'completed',
    connection: 'connected',
    prompt: 'Goal',
    startedAt: 1,
    running: 0,
    queued: 0,
    reused: 0,
    actions: [],
    stages: [],
    calls: [],
    graphRun: {
      spec,
      levels: {},
      gaps: [],
      notes: [],
      steps: [
        {
          id: 'find',
          state: 'done',
          agents: [],
          rounds: [{ round: 1, state: 'done', calls: [], notes: [], items: [source] }]
        },
        {
          id: 'verify',
          state: 'done',
          agents: [],
          rounds: [
            {
              round: 1,
              state: 'done',
              calls: [],
              notes: [],
              targets: [{ ...source, tally: 'unverified', votes: [] }]
            },
            {
              round: 2,
              state: 'done',
              calls: [],
              notes: [],
              targets: [{ ...source, tally: 'confirmed', votes: ['pass'], jevVerify: 0.8 }]
            }
          ]
        }
      ]
    }
  }
  vi.mocked(projectLocalWorkflow).mockReturnValue(view)
  const snapshot_json = JSON.stringify({
    snapshot: {
      task: { prompt: 'Goal' },
      graph: { spec },
      host: { startedAt: 1, workspaceId: 'workspace' }
    }
  })
  const row = {
    id,
    conversation_id: '["workspace","conversation"]',
    snapshot_json,
    snapshot_digest: workflowEvidenceDigest(snapshot_json)
  }
  const child = { state: 'completed' }
  const prepare = vi.fn((_sql: string) => ({ all: () => [row], get: () => child }))
  const db = { prepare } as unknown as Database.Database
  const folder = join(root, id)
  mkdirSync(folder)
  return { db, root, folder, view, row, prepare, child }
}

describe('Discover journal measurement reader', () => {
  it('22, 43, 46: counts a target once in its discovery round after later review, without recovering it', () => {
    const f = fixture()
    const stats = readDiscoverStats(f.db, f.root, {}, 'studio')
    expect(stats.rounds).toEqual([{ round: 1, runs: 1, newFindings: 1, confirmed: 1 }])
    expect(stats.export.runs[0]?.findings).toHaveLength(1)
    expect(stats.export.runs[0]?.findings[0]).toMatchObject({
      sourceCallId: 'find/r1/a0',
      alsoFrom: ['find/r1/a1']
    })
    expect(stats.outcomes.delivery).toEqual({ unknown: 1 })
    expect(f.prepare.mock.calls.every(([sql]) => String(sql).startsWith('SELECT'))).toBe(true)
  })
  it('43, 47: recognizes publication receipts and records failed Start as a failed behavioral label', () => {
    const f = fixture()
    writeFileSync(
      join(f.folder, 'published.json'),
      JSON.stringify({ ok: true, result: { shareUrl: 'https://example.com/page' } })
    )
    writeFileSync(join(f.folder, 'started-1.json'), JSON.stringify({ ok: false }))
    expect(readDiscoverStats(f.db, f.root, {}, 'studio')).toMatchObject({
      outcomes: { delivery: { published: 1 } },
      labels: { Start: { failed: 1 } },
      precision: 'unknown'
    })
    writeFileSync(
      join(f.folder, 'published.json'),
      JSON.stringify({ ok: false, result: { shareUrl: 'https://example.com/page' } })
    )
    writeFileSync(join(f.folder, 'launch.json'), JSON.stringify({ state: 'launched' }))
    expect(readDiscoverStats(f.db, f.root, {}, 'studio').outcomes.delivery).toEqual({ pending: 1 })
  })
  it('47: reads the actual Dig deeper CLI receipt and follows its journaled final state', () => {
    const f = fixture()
    writeFileSync(
      join(f.folder, 'dug-1.json'),
      JSON.stringify({ started: true, executionId: '00000000-0000-4000-8000-000000000002' })
    )
    expect(readDiscoverStats(f.db, f.root, {}, 'studio').labels['Dig deeper'].completed).toBe(1)
    f.child.state = 'failed'
    expect(readDiscoverStats(f.db, f.root, {}, 'studio').labels['Dig deeper'].failed).toBe(1)
    writeFileSync(join(f.folder, 'started-1.json'), JSON.stringify({ ok: true }))
    expect(readDiscoverStats(f.db, f.root, {}, 'studio').labels.Start.unknown).toBe(1)
    writeFileSync(
      join(f.folder, 'started-1.json'),
      JSON.stringify({ ok: true, result: { operationId: 'op', terminal: { handle: 'terminal' } } })
    )
    expect(readDiscoverStats(f.db, f.root, {}, 'studio').labels.Start.launched).toBe(1)
  })

  it('reports corrupt snapshots as unreadable, and honors template/date filters', () => {
    const f = fixture()
    expect(readDiscoverStats(f.db, f.root, { since: 2 }, 'studio').runs).toBe(0)
    expect(readDiscoverStats(f.db, f.root, { template: 'council' }, 'studio').runs).toBe(0)
    f.row.snapshot_digest = 'corrupt'
    expect(readDiscoverStats(f.db, f.root, {}, 'studio')).toMatchObject({ runs: 0, unreadable: 1 })
  })
})
