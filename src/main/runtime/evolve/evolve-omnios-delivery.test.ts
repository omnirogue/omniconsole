import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ArtifactCloudOperation,
  ArtifactPublishResult,
  ArtifactWriteRequest
} from '../../../shared/artifacts'
import type { EvolveLedgerStatus, EvolveRunRecord } from '../../../shared/evolve-workflow'
import Database from '../../sqlite/sync-database'
import { scheduleEvolveToOmnios, type EvolveDecisionPublisher } from './evolve-omnios-delivery'
import { EvolveRunStore } from './evolve-run-store'

const RUN_ID = 'evo_00000000-0000-4000-8000-000000000002'
const SHARE_URL = 'https://omnios.example/a/evolve-decision'
const roots: string[] = []
const databases: Database.Database[] = []
afterEach(async () => {
  databases.splice(0).forEach((db) => db.close())
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function doneRun(promotions?: EvolveLedgerStatus['promotions']): EvolveRunRecord {
  return {
    id: RUN_ID,
    createdAt: '2026-10-16T10:00:00.000Z',
    updatedAt: '2026-10-16T11:00:00.000Z',
    state: 'done',
    request: { target: 'email-smoke' },
    spec: 'jevlab/evolve/email/smoke.yaml',
    checkout: '~/Repos/jev-lab-evolve',
    submittedBy: 'sal',
    placement: {
      runsOn: 'fleet',
      mode: 'remote-runtime',
      host: { name: 'mw0001', machine: 'mw0001', cores: 10, loadPerCore: 0.1, readAt: 0 }
    },
    host: 'mw0001',
    ledger: {
      run_id: 'run_1',
      found: true,
      target: 'email',
      status: 'done',
      spec_sha: 'spec-sha',
      best_so_far: { candidate_id: 'cand_best', program_sha: 'p'.repeat(40), combined_score: 0.81 },
      seeded: [
        {
          candidate_id: 'cand_seed',
          source_run_id: 'run_0',
          source_candidate_id: null,
          program_sha: 'p0',
          prior_combined_score: 0.75,
          prior_promoted: true,
          status: 'scored',
          combined_score: 0.77
        }
      ],
      ...(promotions ? { promotions } : {})
    },
    events: []
  }
}

function published(): ArtifactCloudOperation<ArtifactPublishResult> {
  return {
    status: 'ok',
    value: { change: 'created', item: { shareUrl: SHARE_URL } as ArtifactPublishResult['item'] }
  }
}

async function deps(publish?: EvolveDecisionPublisher) {
  const root = await mkdtemp(join(tmpdir(), 'evolve-omnios-'))
  roots.push(root)
  const db = new Database(':memory:')
  databases.push(db)
  return { db, root, env: {}, store: new EvolveRunStore(join(root, 'runs')), publish }
}

function recommendedLabel(request: ArtifactWriteRequest): string | undefined {
  return request.review?.options?.find((option) => option.recommended)?.label
}

describe('bringing a finished Evolve run to OmniOS Decisions', () => {
  it('never reads missing promotion evidence as a passing audit', async () => {
    const publish = vi.fn<EvolveDecisionPublisher>(async () => published())
    const d = await deps(publish)
    const decision = await scheduleEvolveToOmnios(d, doneRun())
    expect(decision).toMatchObject({ blindAuditPassed: null })
    expect(decision?.blindAuditScore).toContain('No promotion evidence')
    expect(recommendedLabel(publish.mock.calls[0]![0])).toBe('Keep current incumbent')
    const page = await readFile(join(d.root, RUN_ID, 'page.html'), 'utf8')
    expect(page).toContain('(Recommended) Keep current incumbent')
    expect(page).not.toContain('(Recommended) Promote')
  })

  it('recommends promotion only when both gates recorded a pass', async () => {
    const pass = { candidate_id: 'cand_best', decision: 'eligible', availability: 0.99 }
    const passing = vi.fn<EvolveDecisionPublisher>(async () => published())
    const both = await scheduleEvolveToOmnios(
      await deps(passing),
      doneRun([{ ...pass, hard_pass: true, intervals_pass: true }])
    )
    expect(both?.blindAuditPassed).toBe(true)
    expect(recommendedLabel(passing.mock.calls[0]![0])).toBe('Promote winning version')
    const half = await scheduleEvolveToOmnios(
      await deps(),
      doneRun([{ ...pass, hard_pass: true, intervals_pass: null }])
    )
    expect(half?.blindAuditPassed).toBeNull()
    expect(half?.blindAuditScore).toContain('intervals not recorded')
  })

  it('publishes the decision once and keeps its link', async () => {
    const publish = vi.fn<EvolveDecisionPublisher>(async () => published())
    const d = await deps(publish)
    const first = await scheduleEvolveToOmnios(d, doneRun())
    expect(first).toMatchObject({ state: 'published', url: SHARE_URL })
    const receipt = JSON.parse(await readFile(join(d.root, RUN_ID, 'published.json'), 'utf8'))
    expect(receipt).toEqual({ ok: true, result: { shareUrl: SHARE_URL } })
    expect(publish.mock.calls[0]![0]).toMatchObject({
      contentType: 'text/html',
      review: { question: 'Promote winning version cand_best?' }
    })
    expect(await scheduleEvolveToOmnios(d, doneRun())).toMatchObject({ state: 'published' })
    expect(publish).toHaveBeenCalledOnce()
  })

  it('records a refused publish as failed and publishes it on the next pass', async () => {
    const publish = vi
      .fn<EvolveDecisionPublisher>()
      .mockResolvedValueOnce({ status: 'reconnect-required' })
      .mockResolvedValueOnce(published())
    const d = await deps(publish)
    const refused = await scheduleEvolveToOmnios(d, doneRun())
    expect(refused).toMatchObject({ state: 'failed', url: null })
    expect(refused?.error).toContain('sign in again')
    expect(await scheduleEvolveToOmnios(d, doneRun())).toMatchObject({
      state: 'published',
      url: SHARE_URL,
      error: null
    })
    expect(publish).toHaveBeenCalledTimes(2)
  })

  it('stays pending without a publisher instead of claiming delivery', async () => {
    const d = await deps()
    const record = doneRun()
    expect(await scheduleEvolveToOmnios(d, record)).toMatchObject({ state: 'pending', url: null })
    expect(record.events.at(-1)?.text).toContain('not yet in OmniOS Decisions')
  })
})
