import { describe, expect, it } from 'vitest'
import { projectDiscoverEvidence, workflowCallSeatId } from './local-workflow-discover-projection'
import { createLocalWorkflowDraft } from '../../../shared/local-workflow-draft'
import type { LocalWorkflowHostSnapshot } from './local-workflow-host-snapshot'
import { selectDiscoverFindings, type FindingBatch } from './presets/discover-assessment'
import { OrchestrationDb } from '../orchestration/db'
import { WorkflowCheckpointStore, workflowEvidenceDigest } from './workflow-checkpoint-store'
import { projectLocalWorkflow } from './local-workflow-projection'

const snapshot: LocalWorkflowHostSnapshot = {
  version: 1,
  task: { prompt: 'Inspect', evidence: 'Frozen text' },
  seats: [
    { id: 'finder', agent: 'claude', lineage: 'anthropic' },
    { id: 'skeptic-a', agent: 'codex', lineage: 'openai' },
    { id: 'skeptic-b', agent: 'grok', lineage: 'xai' }
  ].map((seat) => ({
    ...seat,
    accountId: 'account',
    model: 'model',
    effort: null,
    policyRevision: 'test'
  })) as LocalWorkflowHostSnapshot['seats'],
  synthesizerId: 'skeptic-a',
  discover: createLocalWorkflowDraft('discover').discover,
  host: {
    workspaceId: 'w',
    conversationId: 'c',
    requestDigest: 'digest',
    startedAt: 1,
    concurrency: 2,
    sources: [{ ref: 'app.ts', description: 'Frozen source' }],
    coverage: ['app.ts inspected']
  }
}
const empty: FindingBatch = { findings: [], omittedCount: 0, omissionReason: '' }
function fixture() {
  const batch: FindingBatch = {
    ...empty,
    findings: [
      {
        issueKey: 'null',
        title: 'Null crash',
        location: 'app.ts',
        trigger: 'Missing input',
        impact: 'Crash',
        severity: 'high',
        evidence: snapshot.host.sources
      }
    ]
  }
  const config = snapshot.discover!
  const batches = [batch, empty, empty]
  const selection = selectDiscoverFindings(batches, { ...config, finderId: 'finder' })
  const id = selection.selected[0].id
  const results = new Map<string, unknown>(
    config.dimensions.map((dimension, index) => [`discover/${dimension}`, batches[index]])
  )
  return { results, id, config }
}

describe('Discover evidence projection', () => {
  it('counts only admitted skeptical verdicts when filtered findings remain inspectable', () => {
    const db = new OrchestrationDb(':memory:')
    try {
      const store = new WorkflowCheckpointStore(db.db)
      const high = {
        issueKey: 'retry-race',
        title: 'Retry race',
        location: 'src/retry.ts:12',
        trigger: 'Lost acknowledgement',
        impact: 'Duplicate work',
        severity: 'high' as const,
        evidence: [{ ref: 'src/retry.ts:12', description: 'No durable intent' }]
      }
      const low = {
        ...high,
        issueKey: 'minor-label',
        title: 'Minor label',
        severity: 'low' as const
      }
      const config = { ...snapshot.discover!, maxCandidates: 1 }
      const frozen = { ...snapshot, discover: config, discoverProgramRevision: 5 as const }
      const batches: FindingBatch[] = [
        { findings: [high, low], omittedCount: 0, omissionReason: '' },
        empty,
        empty
      ]
      const id = store.create({
        conversationId: 'conversation',
        requestId: 'request',
        snapshot: frozen,
        preset: 'discover',
        fence: 1,
        attemptLimit: 3,
        callLimit: 30,
        budgetLimit: 90
      })
      const results = new Map<string, unknown>(
        config.dimensions.map((dimension, index) => [`discover/${dimension}`, batches[index]])
      )
      const findingId = selectDiscoverFindings(batches, {
        ...config,
        revision: 5,
        finderId: snapshot.seats[0].id
      }).selected[0].id
      for (const lens of config.lenses) {
        results.set(`refute/${findingId}/${lens}`, {
          refuted: false,
          uncertain: false,
          reason: 'The frozen evidence supports the finding.'
        })
      }
      for (const [callId, value] of results) {
        const json = JSON.stringify(value)
        db.db
          .prepare(
            'INSERT INTO local_workflow_calls (execution_id, call_id, input_digest, result_json, result_digest) VALUES (?, ?, ?, ?, ?)'
          )
          .run(id, callId, 'input', json, workflowEvidenceDigest(json))
      }
      const view = projectLocalWorkflow({ db: db.db, store, executionId: id, active: true })
      const refute = view.stages.find((stage) => stage.id === 'refute')
      expect(view.discoverCounts).toMatchObject({ found: 2, assessed: 1, verdictsTotal: 2 })
      expect(view.findings).toHaveLength(2)
      expect(refute).toMatchObject({ completed: 2, total: 2 })
    } finally {
      db.close()
    }
  })

  it('keeps each filtered finder observation inspectable with explicit assessment counts', () => {
    const high = {
      issueKey: 'retry-race',
      title: 'Retry race',
      location: 'src/retry.ts:12',
      trigger: 'Lost acknowledgement',
      impact: 'Duplicate work',
      severity: 'high' as const,
      evidence: [{ ref: 'src/retry.ts:12', description: 'No durable intent' }]
    }
    const other = {
      ...high,
      issueKey: 'cache-stale',
      title: 'Stale cache',
      location: 'src/cache.ts:8',
      trigger: 'Changed scope',
      impact: 'Wrong context',
      evidence: [{ ref: 'src/cache.ts:8', description: 'Missing scope digest' }]
    }
    const low = { ...high, issueKey: 'minor-label', title: 'Minor label', severity: 'low' as const }
    const config = { ...snapshot.discover!, maxCandidates: 1 }
    const batches: FindingBatch[] = [
      {
        findings: [high, { ...high, title: 'Retry race duplicate' }],
        omittedCount: 0,
        omissionReason: ''
      },
      { findings: [other], omittedCount: 0, omissionReason: '' },
      { findings: [low], omittedCount: 0, omissionReason: '' }
    ]
    const results = new Map<string, unknown>(
      config.dimensions.map((dimension, index) => [`discover/${dimension}`, batches[index]])
    )
    const view = projectDiscoverEvidence({ ...snapshot, discover: config }, results, false)
    expect(view.discoverCounts).toMatchObject({
      found: 4,
      duplicates: 1,
      belowThreshold: 1,
      overLimit: 1,
      assessed: 1,
      verdictsCompleted: 0,
      verdictsTotal: 2
    })
    expect(view.findings).toHaveLength(4)
    expect(view.findings?.length).toBe(view.discoverCounts?.found)
    expect(view.findings?.map((finding) => finding.disposition)).toEqual(
      expect.arrayContaining(['duplicate', 'below threshold', 'over candidate limit'])
    )
    expect(view.findings?.find((finding) => finding.label === 'Minor label')?.sources).toEqual(
      low.evidence
    )
  })

  it('waits for both revision-five cluster votes before revealing candidates, then retains limit exclusions', () => {
    const first = {
      issueKey: 'retry-race',
      title: 'Retry race',
      location: 'src/retry.ts:12',
      trigger: 'Lost acknowledgement',
      impact: 'Duplicate work',
      severity: 'high' as const,
      evidence: [{ ref: 'src/retry.ts:12', description: 'No durable intent' }]
    }
    const second = {
      ...first,
      issueKey: 'stale-cache',
      title: 'Stale cache',
      location: 'src/cache.ts:8'
    }
    const third = {
      ...first,
      issueKey: 'missing-fence',
      title: 'Missing fence',
      location: 'src/lease.ts:20'
    }
    const config = { ...snapshot.discover!, maxCandidates: 2 }
    const batches: FindingBatch[] = [
      { findings: [first], omittedCount: 0, omissionReason: '' },
      { findings: [second], omittedCount: 0, omissionReason: '' },
      { findings: [third], omittedCount: 0, omissionReason: '' }
    ]
    const results = new Map<string, unknown>(
      config.dimensions.map((dimension, index) => [`discover/${dimension}`, batches[index]])
    )
    const revised = { ...snapshot, discover: config, discoverProgramRevision: 5 as const }
    expect(projectDiscoverEvidence(revised, results, false)).toEqual({})
    const ids = selectDiscoverFindings(batches, {
      ...config,
      finderId: snapshot.seats[0].id,
      maxCandidates: 12,
      revision: 5
    }).selected.map((finding) => finding.id)
    const vote = { groups: ids.map((id) => ({ ids: [id], reason: 'Separate mechanisms' })) }
    results.set('cluster/0', vote)
    results.set('cluster/1', vote)
    const view = projectDiscoverEvidence(revised, results, false)
    expect(view.discoverCounts).toMatchObject({ found: 3, assessed: 2, overLimit: 1 })
    expect(view.findings).toHaveLength(3)
    expect(view.findings?.length).toBe(view.discoverCounts?.found)
  })

  it('uses frozen Discover revision when reconstructing candidate IDs', () => {
    const first = {
      issueKey: 'tenant-cache-key-missing-tenant',
      title: 'Tenant cache collision',
      location: 'src/cache.ts:1-8',
      trigger: 'Tenant B requests shared report',
      impact: 'Cross-tenant response',
      severity: 'high' as const,
      evidence: [{ ref: 'src/cache.ts', description: 'Key omits tenant' }]
    }
    const second = { ...first, trigger: 'B receives tenant A cache hit' }
    const batches: FindingBatch[] = [
      { findings: [first], omittedCount: 0, omissionReason: '' },
      { findings: [second], omittedCount: 0, omissionReason: '' },
      empty
    ]
    const results = new Map(
      snapshot.discover!.dimensions.map((dimension, index) => [
        `discover/${dimension}`,
        batches[index]
      ])
    )
    expect(projectDiscoverEvidence(snapshot, results, false).discoverCounts?.assessed).toBe(2)
    const secondRevision = projectDiscoverEvidence(
      { ...snapshot, discoverProgramRevision: 2 },
      results,
      false
    )
    expect(secondRevision.discoverCounts).toMatchObject({ assessed: 1, duplicates: 1 })
    expect(secondRevision.findings).toHaveLength(2)
    expect(secondRevision.findings?.[1].disposition).toBe('duplicate')
    expect(
      projectDiscoverEvidence({ ...snapshot, discoverProgramRevision: 3 }, results, false)
        .discoverCounts?.assessed
    ).toBe(1)
  })

  it('reconstructs unanimous revision-four clustering from accepted calls', () => {
    const first = {
      issueKey: 'activity-pagination-tie-skip',
      title: 'Tied rows skipped',
      location: 'src/activity.ts:1-10',
      trigger: 'Tied timestamp reaches page boundary',
      impact: 'Missing rows',
      severity: 'high' as const,
      evidence: [{ ref: 'src/activity.ts:1-10', description: 'Strict timestamp filter' }]
    }
    const batches: FindingBatch[] = [
      { findings: [first], omittedCount: 0, omissionReason: '' },
      {
        findings: [{ ...first, issueKey: 'activity-cursor-skips-same-timestamp-rows' }],
        omittedCount: 0,
        omissionReason: ''
      },
      empty
    ]
    const config = snapshot.discover!
    const ids = selectDiscoverFindings(batches, {
      ...config,
      finderId: snapshot.seats[0].id,
      revision: 2
    }).selected.map((item) => item.id)
    const results = new Map<string, unknown>(
      config.dimensions.map((dimension, index) => [`discover/${dimension}`, batches[index]])
    )
    const vote = { groups: [{ ids, reason: 'Same timestamp cursor root' }] }
    results.set('cluster/0', vote)
    results.set('cluster/1', vote)
    for (const lens of config.lenses) {
      results.set(`refute/${ids[0]}/${lens}`, {
        refuted: false,
        uncertain: false,
        reason: 'Supported',
        evidence: []
      })
    }
    results.set('rank/final', {
      summary: 'Confirmed',
      ranking: [{ findingId: ids[0], reason: 'Missing rows', nextAction: 'Fix cursor' }]
    })
    const revised = { ...snapshot, discoverProgramRevision: 4 as const }
    expect(projectDiscoverEvidence(revised, results, true).discoverCounts).toMatchObject({
      found: 2,
      duplicates: 1,
      assessed: 1,
      verdictsCompleted: 2,
      verdictsTotal: 2
    })
    expect(projectDiscoverEvidence(revised, results, true).findings).toHaveLength(2)
    expect(projectDiscoverEvidence(revised, results, true).result?.markdown).toContain('Confirmed')
    expect(workflowCallSeatId(revised, 'cluster/0')).toBe('finder')
    expect(workflowCallSeatId(revised, 'cluster/1')).toBe('skeptic-b')
  })
  it('shows a completed empty result with coverage without inventing a ranking call', () => {
    const results = new Map(
      snapshot.discover!.dimensions.map((dimension) => [`discover/${dimension}`, empty])
    )
    expect(projectDiscoverEvidence(snapshot, results, true)).toMatchObject({
      findings: [],
      result: { markdown: 'No findings in the inspected scope.', sources: snapshot.host.sources }
    })
  })

  it('retains missing verdicts as unresolved and rejects incomplete completion', () => {
    const { results, id, config } = fixture()
    results.set(`refute/${id}/${config.lenses[0]}`, {
      refuted: false,
      uncertain: false,
      reason: 'Supported',
      evidence: []
    })
    expect(projectDiscoverEvidence(snapshot, results, false).findings?.[0]).toMatchObject({
      disposition: 'unresolved',
      verdicts: [{ verdict: 'survives' }, { verdict: 'unresolved' }]
    })
    expect(() => projectDiscoverEvidence(snapshot, results, true)).toThrow('incomplete')
  })

  it('counts an uncertain two-skeptic refutation as not verified rather than a proven refutation', () => {
    const { results, id, config } = fixture()
    for (const [index, lens] of config.lenses.entries()) {
      results.set(`refute/${id}/${lens}`, {
        refuted: true,
        uncertain: index === 1,
        reason: index === 1 ? 'Evidence does not settle the user path' : 'Mechanism challenged',
        evidence: []
      })
    }
    const view = projectDiscoverEvidence(snapshot, results, true)
    expect(view.findings?.[0].disposition).toBe('insufficient-evidence')
    expect(view.discoverCounts).toMatchObject({
      assessed: 1,
      verdictsCompleted: 2,
      survivors: 0,
      refuted: 0,
      notVerified: 1,
      unresolved: 0
    })
  })

  it('renders ranked contested findings and preserves uncertain verdicts', () => {
    const { results, id, config } = fixture()
    config.lenses.forEach((lens, index) =>
      results.set(`refute/${id}/${lens}`, {
        refuted: index === 1,
        uncertain: index === 1,
        reason: 'Evidence explanation',
        evidence: []
      })
    )
    expect(() => projectDiscoverEvidence(snapshot, results, true)).toThrow('incomplete')
    results.set('rank/final', {
      summary: 'Review input handling',
      ranking: [{ findingId: id, reason: 'User impact', nextAction: 'Check the boundary' }]
    })
    const view = projectDiscoverEvidence(snapshot, results, true)
    expect(view.result?.markdown).toContain('Null crash (contested)')
    expect(view.result?.markdown).toContain('Check the boundary')
    expect(view.findings?.[0].verdicts[1].verdict).toBe('uncertain')
  })

  it('shows reviewed ranking text and evidence instead of stale finder claims', () => {
    const { results, id, config } = fixture()
    const batch = results.get(`discover/${config.dimensions[0]}`) as FindingBatch
    batch.findings[0].impact = 'Crash, plus an unverified second failure.'
    batch.findings[0].evidence = [
      { ref: 'app.ts', description: 'Unguarded access' },
      { ref: 'app.ts', description: 'Unverified second failure' }
    ]
    for (const lens of config.lenses) {
      results.set(`refute/${id}/${lens}`, {
        refuted: false,
        uncertain: false,
        reason: 'The crash is supported; the second failure is not.',
        evidence: []
      })
    }
    results.set('rank/final', {
      summary: 'One supported crash',
      ranking: [
        {
          findingId: id,
          reason: 'A real crash on missing input',
          nextAction: 'Guard input before access',
          finding: {
            title: 'Null crash',
            location: 'app.ts',
            trigger: 'Missing input',
            impact: 'Crash',
            severity: 'high',
            evidence: [{ ref: 'app.ts', description: 'Unguarded access' }]
          }
        }
      ]
    })
    const view = projectDiscoverEvidence(snapshot, results, true)
    expect(view.findings?.[0].markdown).toContain('Impact: Crash')
    expect(view.findings?.[0].sources).toEqual([{ ref: 'app.ts', description: 'Unguarded access' }])
    expect(view.result?.markdown).toContain('Null crash (survives)')
    expect(JSON.stringify(view)).not.toContain('unverified second failure')
  })

  it('maps Discover semantic call identities to the actual frozen seats', () => {
    expect(workflowCallSeatId(snapshot, 'discover/Reliability / resume')).toBe('finder')
    expect(workflowCallSeatId(snapshot, `refute/finding-id/${snapshot.discover!.lenses[1]}`)).toBe(
      'skeptic-b'
    )
    expect(
      workflowCallSeatId(
        {
          ...snapshot,
          discover: {
            ...snapshot.discover!,
            lenses: ['Evidence / safeguards', 'Actual occurrence']
          }
        },
        'refute/finding-id/Evidence / safeguards'
      )
    ).toBe('skeptic-a')
    expect(workflowCallSeatId(snapshot, 'rank/final')).toBe('skeptic-a')
    expect(workflowCallSeatId(snapshot, 'refute/finding-id/unknown')).toBeUndefined()
  })
})
