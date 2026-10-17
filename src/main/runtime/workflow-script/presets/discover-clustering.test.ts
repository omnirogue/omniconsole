import { describe, expect, it } from 'vitest'
import {
  consensusDiscoverClusters,
  limitDiscoverSelection,
  validateDiscoverClusters,
  type DiscoverClusterVote
} from './discover-clustering'
import { selectDiscoverFindings, type Finding, type FindingBatch } from './discover-assessment'
import { runDiscoverProgram, type DiscoverConfig } from './discover'
import { createWorkflowProgramContext, type WorkflowProgramCall } from '../workflow-program-context'
import { projectDiscoverEvidence } from '../local-workflow-discover-projection'
import type { LocalWorkflowHostSnapshot } from '../local-workflow-host-snapshot'

function finding(issueKey: string, location = 'src/seats.ts:1-10'): Finding {
  return {
    issueKey,
    title: issueKey,
    location,
    trigger: issueKey,
    impact: issueKey,
    severity: 'high',
    evidence: [{ ref: 'src/seats.ts:1-10', description: issueKey }]
  }
}
function selected(findings: Finding[]) {
  const batches: FindingBatch[] = [
    { findings, omittedCount: 0, omissionReason: '' },
    { findings: [], omittedCount: 0, omissionReason: '' },
    { findings: [], omittedCount: 0, omissionReason: '' }
  ]
  return selectDiscoverFindings(batches, {
    dimensions: ['correctness', 'path', 'reliability'],
    finderId: 'finder',
    minimumSeverity: 'medium',
    maxCandidates: 12,
    revision: 2
  })
}
function vote(groups: string[][]): DiscoverClusterVote {
  return { groups: groups.map((ids) => ({ ids, reason: 'Same supported mechanism' })) }
}

describe('Discover model-assisted root-cause review', () => {
  it('keeps distinct triggers or evidence for revision five reviewers while collapsing only an identical finding', () => {
    const membership = {
      ...finding('seat-grant-validation-failure'),
      trigger: 'Missing membership check'
    }
    const quota = {
      ...finding('seat-grant-validation-failure'),
      trigger: 'Missing quota check'
    }
    const differentEvidence = {
      ...membership,
      title: 'Different membership path',
      evidence: [{ ref: 'src/seats.ts:1-10', description: 'Different guard path' }]
    }
    const batches: FindingBatch[] = [
      { findings: [membership, quota, differentEvidence], omittedCount: 0, omissionReason: '' },
      { findings: [membership], omittedCount: 0, omissionReason: '' },
      { findings: [], omittedCount: 0, omissionReason: '' }
    ]
    const selection = selectDiscoverFindings(batches, {
      dimensions: ['correctness', 'path', 'reliability'],
      finderId: 'finder',
      minimumSeverity: 'medium',
      maxCandidates: 12,
      revision: 5
    })
    expect(selection.selected).toHaveLength(3)
    expect(selection.selected.map((item) => item.trigger).sort()).toEqual([
      'Missing membership check',
      'Missing membership check',
      'Missing quota check'
    ])
    expect(selection.selected.map((item) => item.title)).toContain('Different membership path')
    expect(selection.excluded).toMatchObject([{ reason: 'duplicate' }])
    expect(selection.selected.map((item) => item.sources.length).sort()).toEqual([1, 1, 2])
    expect(
      selectDiscoverFindings(batches, {
        dimensions: ['correctness', 'path', 'reliability'],
        finderId: 'finder',
        minimumSeverity: 'medium',
        maxCandidates: 12,
        revision: 2
      }).selected
    ).toHaveLength(1)
  })

  it('applies the candidate quota after unanimous clustering in revision five', () => {
    const selection = selectDiscoverFindings(
      [
        {
          findings: [
            finding('membership-a'),
            finding('membership-paraphrase'),
            { ...finding('quota-b'), severity: 'medium' as const }
          ],
          omittedCount: 0,
          omissionReason: ''
        },
        { findings: [], omittedCount: 0, omissionReason: '' },
        { findings: [], omittedCount: 0, omissionReason: '' }
      ],
      {
        dimensions: ['correctness', 'path', 'reliability'],
        finderId: 'finder',
        minimumSeverity: 'medium',
        maxCandidates: 12,
        revision: 5
      }
    )
    const ids = selection.selected.map((item) => item.id)
    expect(ids).toHaveLength(3)
    const clustered = consensusDiscoverClusters(selection, [
      vote([[ids[0], ids[1]], [ids[2]]]),
      vote([[ids[0], ids[1]], [ids[2]]])
    ])
    const limited = limitDiscoverSelection(clustered, 2)
    expect(limited.selected).toHaveLength(2)
    expect(limited.selected[0].sources).toHaveLength(2)
    expect(limited.selected[1].issueKey).toBe('quota-b')
    expect(limited.excluded).toHaveLength(1)
  })

  it('runs revision five with all candidates visible to reviewers and matching final projection', async () => {
    const calls: WorkflowProgramCall[] = []
    const results = new Map<string, unknown>()
    const config: DiscoverConfig = {
      revision: 5,
      finder: { id: 'finder', lineage: 'anthropic' },
      skeptics: [
        { id: 'skeptic-a', lineage: 'openai' },
        { id: 'skeptic-b', lineage: 'xai' }
      ],
      synthesizer: { id: 'finder', lineage: 'anthropic' },
      dimensions: ['correctness', 'path', 'reliability'],
      lenses: ['mechanism', 'occurrence'],
      minimumSeverity: 'medium',
      maxCandidates: 2
    }
    const task = { prompt: 'Check seat grants', evidence: 'Frozen membership and quota guards' }
    const context = createWorkflowProgramContext({
      guard: () => {},
      isFatal: () => false,
      phase: () => {},
      log: () => {},
      agent: async (call) => {
        calls.push(call)
        let value: unknown
        if (call.id.startsWith('discover/')) {
          value = {
            findings:
              call.id === 'discover/correctness'
                ? [
                    finding('membership-a'),
                    finding('membership-paraphrase'),
                    { ...finding('quota-b'), severity: 'medium' as const }
                  ]
                : [],
            omittedCount: 0,
            omissionReason: ''
          }
        } else if (call.id.startsWith('cluster/')) {
          const packet = JSON.parse(call.prompt.slice(call.prompt.indexOf('\n') + 1)) as {
            candidates: { id: string; issueKey: string }[]
          }
          value = vote([
            packet.candidates
              .filter((item) => item.issueKey.startsWith('membership'))
              .map((item) => item.id),
            packet.candidates.filter((item) => item.issueKey === 'quota-b').map((item) => item.id)
          ])
        } else if (call.id.startsWith('refute/')) {
          value = { refuted: false, uncertain: false, reason: 'Supported', evidence: [] }
        } else {
          const packet = JSON.parse(call.prompt.slice(call.prompt.indexOf('\n') + 1)) as {
            survivors: { id: string }[]
          }
          value = {
            summary: 'Two distinct roots',
            ranking: packet.survivors.map((item) => ({
              findingId: item.id,
              reason: 'Supported',
              nextAction: 'Repair guard'
            }))
          }
        }
        results.set(call.id, value)
        return value
      }
    })
    const outcome = await runDiscoverProgram(context, config, task)
    expect(calls.filter((call) => call.id.startsWith('cluster/'))).toHaveLength(2)
    expect(
      calls
        .filter((call) => call.id.startsWith('cluster/'))
        .every((call) => {
          const packet = JSON.parse(call.prompt.slice(call.prompt.indexOf('\n') + 1)) as {
            candidates: unknown[]
          }
          return packet.candidates.length === 3
        })
    ).toBe(true)
    expect(calls.filter((call) => call.id.startsWith('refute/'))).toHaveLength(4)
    expect(calls).toHaveLength(10)
    expect(outcome.selection.selected).toHaveLength(2)
    expect(outcome.selection.selected.map((item) => item.issueKey)).toContain('quota-b')
    const snapshot: LocalWorkflowHostSnapshot = {
      version: 1,
      discoverProgramRevision: 5,
      task,
      seats: [config.finder, ...config.skeptics].map((seat) => ({
        ...seat,
        agent: seat.id === 'finder' ? 'claude' : seat.id === 'skeptic-a' ? 'codex' : 'grok',
        accountId: 'test',
        model: 'test',
        effort: null,
        policyRevision: 'test'
      })) as LocalWorkflowHostSnapshot['seats'],
      synthesizerId: config.synthesizer.id,
      discover: config,
      host: {
        workspaceId: 'w',
        conversationId: 'c',
        requestDigest: 'digest',
        startedAt: 1,
        concurrency: 2,
        sources: [],
        coverage: []
      }
    }
    const pending = new Map(results)
    pending.delete('cluster/1')
    expect(projectDiscoverEvidence(snapshot, pending, false).findings).toBeUndefined()
    const projected = projectDiscoverEvidence(snapshot, results, true)
    expect(
      projected.findings?.filter((item) => item.verdicts.length).map((item) => item.id)
    ).toEqual(outcome.selection.selected.map((item) => item.id))
    expect(projected.discoverCounts).toMatchObject({ found: 3, assessed: 2, duplicates: 1 })
    expect(projected.findings?.find((item) => item.disposition === 'duplicate')).toMatchObject({
      label: 'membership-paraphrase',
      verdicts: []
    })
    expect(projected.result?.markdown).toContain('Two distinct roots')
  })
  it('requires a complete partition of accepted candidate IDs', () => {
    const candidates = selected([finding('membership'), finding('quota')]).selected
    const [a, b] = candidates.map((item) => item.id)
    expect(validateDiscoverClusters(vote([[a], [b]]), candidates)).toBeNull()
    expect(validateDiscoverClusters(vote([[a]]), candidates)).toMatch(/partition/)
    expect(validateDiscoverClusters(vote([[a, b], [a]]), candidates)).toMatch(/partition/)
    expect(validateDiscoverClusters(vote([[a, 'invented'], [b]]), candidates)).toMatch(/partition/)
  })

  it('merges paraphrases only on unanimous same-mechanism agreement', () => {
    const selection = selected([
      finding('activity-pagination-tie-skip'),
      finding('activity-cursor-skips-same-timestamp-rows')
    ])
    const ids = selection.selected.map((item) => item.id)
    const unanimous = consensusDiscoverClusters(selection, [vote([ids]), vote([ids])])
    expect(unanimous.selected).toHaveLength(1)
    expect(unanimous.selected[0].sources).toHaveLength(2)
    expect(unanimous.excluded).toMatchObject([{ reason: 'duplicate' }])
    expect(
      consensusDiscoverClusters(selection, [vote([ids]), vote(ids.map((id) => [id]))]).selected
    ).toHaveLength(2)
  })

  it('preserves membership and quota as distinct same-file mechanisms', () => {
    const selection = selected([
      finding('seat-grant-missing-membership-check'),
      finding('seat-grant-missing-quota-check')
    ])
    const ids = selection.selected.map((item) => item.id)
    const reviewed = consensusDiscoverClusters(selection, [
      vote(ids.map((id) => [id])),
      vote(ids.map((id) => [id]))
    ])
    expect(reviewed.selected).toHaveLength(2)
    expect(reviewed.excluded).toHaveLength(0)
  })

  it('never merges different paths or disjoint lines even on unanimous votes', () => {
    const selection = selected([
      finding('same-mechanism-a', 'src/a.ts:1-5'),
      finding('same-mechanism-b', 'src/a.ts:20-25'),
      finding('same-mechanism-c', 'src/b.ts:1-5')
    ])
    const ids = selection.selected.map((item) => item.id)
    expect(consensusDiscoverClusters(selection, [vote([ids]), vote([ids])]).selected).toHaveLength(
      3
    )
  })

  it('runs two independent cluster calls before skeptical review and rank', async () => {
    const calls: WorkflowProgramCall[] = []
    const config: DiscoverConfig = {
      revision: 4,
      finder: { id: 'claude', lineage: 'anthropic' },
      skeptics: [
        { id: 'codex', lineage: 'openai' },
        { id: 'grok', lineage: 'xai' }
      ],
      synthesizer: { id: 'claude', lineage: 'anthropic' },
      dimensions: ['correctness', 'path', 'reliability'],
      lenses: ['mechanism', 'occurrence'],
      minimumSeverity: 'medium',
      maxCandidates: 12
    }
    const context = createWorkflowProgramContext({
      guard: () => {},
      isFatal: () => false,
      phase: () => {},
      log: () => {},
      agent: async (call) => {
        calls.push(call)
        if (call.id.startsWith('discover/')) {
          return {
            findings: [
              finding('seat-grant-missing-membership-check'),
              finding('seat-grant-missing-quota-check')
            ],
            omittedCount: 0,
            omissionReason: ''
          }
        }
        if (call.id.startsWith('cluster/')) {
          const packet = JSON.parse(call.prompt.slice(call.prompt.indexOf('\n') + 1)) as {
            candidates: { id: string }[]
          }
          return vote(packet.candidates.map((item) => [item.id]))
        }
        if (call.id.startsWith('refute/')) {
          return { refuted: false, uncertain: false, reason: 'Supported', evidence: [] }
        }
        const packet = JSON.parse(call.prompt.slice(call.prompt.indexOf('\n') + 1)) as {
          survivors: { id: string }[]
        }
        return {
          summary: 'Two separate roots',
          ranking: packet.survivors.map((item) => ({
            findingId: item.id,
            reason: 'Supported',
            nextAction: 'Repair condition'
          }))
        }
      }
    })
    const result = await runDiscoverProgram(context, config, {
      prompt: 'Inspect seat grants',
      evidence: 'Membership and quota contracts'
    })
    expect(result.selection.selected).toHaveLength(2)
    expect(result.survivors).toHaveLength(2)
    expect(calls.filter((call) => call.id.startsWith('cluster/'))).toMatchObject([
      { id: 'cluster/0', seatId: 'claude' },
      { id: 'cluster/1', seatId: 'grok' }
    ])
    expect(calls.filter((call) => call.id.startsWith('refute/'))).toHaveLength(4)
    expect(calls).toHaveLength(10)
    expect(
      calls
        .filter((call) => call.id.startsWith('refute/'))
        .every(
          (call) =>
            call.dependencies.includes('cluster/0') && call.dependencies.includes('cluster/1')
        )
    ).toBe(true)
  })
})
