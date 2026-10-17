import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AuditFinding } from '../../../../shared/workflow-audit-contracts'
import { buildAuditCorpus } from './audit-corpus'
import {
  createWorkflowProgramContext,
  type WorkflowProgramContext
} from '../workflow-program-context'
import { auditFixtureSnapshot } from '../../../../../config/scripts/workflows/probe-audit-pipeline'
import { findAuditNovelty, readAudit } from './audit-read'
import type { AuditSnapshot } from './audit-snapshot'
import {
  assertAuditClusterInputCapacity,
  AuditClusterCapacityError
} from './audit-cluster-capacity'

function finding(id: string, sourceId: string, quotes: string[]): AuditFinding {
  return {
    id,
    title: id,
    description: 'Description',
    evidence: quotes.map((quote) => ({ sourceId, quote })),
    impact: 1,
    proposedFix: 'Fix'
  }
}

function createCorpus(sourceCount: number) {
  const sources = Array.from({ length: sourceCount }, (_, index) => ({
    id: `source-${String(index).padStart(2, '0')}`,
    timestamp: '2026-01-01T00:00:00.000Z',
    text: 'Fixture source body'
  }))
  const chunkBytes = buildAuditCorpus([sources[0]], { maxChunkBytes: 4096 }).chunks[0].bytes
  return buildAuditCorpus(sources, { maxChunkBytes: chunkBytes })
}

function context(): WorkflowProgramContext {
  return createWorkflowProgramContext({
    agent: async () => {
      throw new Error('Unexpected agent call')
    },
    phase: () => {},
    log: () => {},
    guard: () => {},
    isFatal: () => false
  })
}

describe('audit cluster input capacity', () => {
  const directory = mkdtempSync(join(tmpdir(), 'audit-cluster-capacity-'))
  let fixtureAudit: AuditSnapshot

  beforeAll(() => {
    fixtureAudit = auditFixtureSnapshot(directory).audit!
  })

  afterAll(() => rmSync(directory, { recursive: true, force: true }))

  function auditFor(
    version: 1 | 2 | 3 | 4 | 5,
    sourceCount: number,
    clusterGroups: number,
    maxThemes = 12
  ): AuditSnapshot {
    return {
      ...fixtureAudit,
      version,
      corpus: createCorpus(sourceCount),
      clusterGroups,
      maxThemes,
      existingFindings: []
    }
  }

  it('allows the exact output boundary and counts duplicate citation pairs once', () => {
    const atLimit = Array.from({ length: 12 }, (_, i) =>
      finding(
        `finding-${i}`,
        'source-00',
        Array.from({ length: 128 }, (_, j) => `quote-${i}-${j}`)
      )
    )
    expect(() => assertAuditClusterInputCapacity(atLimit, 12)).not.toThrow()
    expect(() => assertAuditClusterInputCapacity([...atLimit, ...atLimit], 12)).not.toThrow()
  })

  it.each([2, 3, 4, 5] as const)(
    'rejects intermediate cluster overflow in revision %i and launches no cluster or merge call',
    async (version) => {
      const audit = auditFor(version, 8, 1)
      const calls: string[] = []
      const ask = async (id: string, _instruction: string, _seatId: string, data: unknown) => {
        calls.push(id)
        if (id.startsWith('read/')) {
          const chunk = (data as { chunk: { id: string; sourceIds: string[] } }).chunk
          return {
            version: 1,
            chunkId: chunk.id,
            sourceIds: chunk.sourceIds,
            findings: Array.from({ length: 24 }, (_, findingIndex) =>
              finding(
                `finding-${chunk.id}-${findingIndex}`,
                chunk.sourceIds[0],
                Array.from(
                  { length: 128 },
                  (_, citationIndex) => `quote-${chunk.id}-${findingIndex}-${citationIndex}`
                )
              )
            )
          }
        }
        throw new Error(`Unexpected call: ${id}`)
      }

      await expect(readAudit(context(), ask as never, audit)).rejects.toThrow(
        'Audit cluster cannot preserve 24576 unique citation pairs; output capacity is 16384'
      )
      expect(calls).toHaveLength(8)
      expect(calls.every((id) => id.startsWith('read/'))).toBe(true)
    }
  )

  it.each([2, 3, 4, 5] as const)(
    'rejects final merge overflow before the revision %i merge call',
    async (version) => {
      const audit = auditFor(version, 2, 2)
      const calls: string[] = []
      const ask = async (id: string, _instruction: string, _seatId: string, data: unknown) => {
        calls.push(id)
        if (id.startsWith('read/')) {
          const chunk = (data as { chunk: { id: string; sourceIds: string[] } }).chunk
          return {
            version: 1,
            chunkId: chunk.id,
            sourceIds: chunk.sourceIds,
            findings: Array.from({ length: 13 }, (_, findingIndex) =>
              finding(
                `finding-${chunk.id}-${findingIndex}`,
                chunk.sourceIds[0],
                Array.from(
                  { length: 60 },
                  (_, citationIndex) => `quote-${chunk.id}-${findingIndex}-${citationIndex}`
                )
              )
            )
          }
        }
        if (id.startsWith('cluster/')) {
          return { version: 1, findings: (data as { findings: AuditFinding[] }).findings }
        }
        throw new Error(`Unexpected call: ${id}`)
      }

      await expect(readAudit(context(), ask as never, audit)).rejects.toThrow(
        'Audit cluster cannot preserve 1560 unique citation pairs; output capacity is 1536'
      )
      expect(calls.filter((id) => id.startsWith('cluster/'))).toHaveLength(2)
      expect(calls).not.toContain('merge')
    }
  )

  it.each([2, 3, 4, 5] as const)(
    'rejects novelty merge overflow before the revision %i novelty merge call',
    async (version) => {
      const audit = auditFor(version, 1, 1)
      const existing = Array.from({ length: 13 }, (_, i) =>
        finding(
          `finding-${i}`,
          audit.corpus.sources[0].id,
          Array.from({ length: 128 }, (_, j) => `quote-${i}-${j}`)
        )
      )
      const calls: string[] = []
      const ask = async (id: string) => {
        calls.push(id)
        return {
          version: 1,
          lens: 'Repeated work',
          existingFindingIds: existing.map(({ id: findingId }) => findingId),
          findings: []
        }
      }
      await expect(
        findAuditNovelty(context(), ask as never, audit, existing, [])
      ).rejects.toBeInstanceOf(AuditClusterCapacityError)
      expect(calls).toEqual(['novelty/0'])
    }
  )

  it('keeps v1 novelty merge prompt and result path unchanged', async () => {
    const audit = auditFor(1, 1, 1)
    const existing = [finding('existing', audit.corpus.sources[0].id, ['quote'])]
    const calls: { id: string; instruction: string }[] = []
    const ask = async (id: string, instruction: string) => {
      calls.push({ id, instruction })
      if (id === 'novelty/0') {
        return {
          version: 1,
          lens: 'Repeated work',
          existingFindingIds: ['existing'],
          findings: []
        }
      }
      return { version: 1, findings: existing }
    }
    const result = await findAuditNovelty(context(), ask as never, audit, existing, [])
    expect(calls.map(({ id }) => id)).toEqual(['novelty/0', 'novelty-merge'])
    expect(calls[1].instruction).toBe(
      'Cluster related findings into themes. Merge evidence by distinct source IDs, preserving every supplied citation pair exactly; never invent a quote or sum model counts. Keep opposing claims distinguishable. Return unique theme IDs. Explain the proposed change concretely. Compare candidates against the existing list and each other. Preserve contradictions. Return at most 12 themes.'
    )
    expect(result.findings).toEqual(existing)
  })

  it('keeps the v1 final merge prompt and result path unchanged', async () => {
    const audit = auditFor(1, 2, 2)
    const calls: { id: string; instruction: string }[] = []
    const ask = async (id: string, instruction: string, _seatId: string, data: unknown) => {
      calls.push({ id, instruction })
      if (id.startsWith('read/')) {
        const chunk = (data as { chunk: { id: string; sourceIds: string[] } }).chunk
        return { version: 1, chunkId: chunk.id, sourceIds: chunk.sourceIds, findings: [] }
      }
      return { version: 1, findings: [] }
    }
    const result = await readAudit(context(), ask as never, audit)
    expect(calls.find(({ id }) => id === 'merge')?.instruction).toBe(
      'Cluster related findings into themes. Merge evidence by distinct source IDs, preserving every supplied citation pair exactly; never invent a quote or sum model counts. Keep opposing claims distinguishable. Return unique theme IDs. Explain the proposed change concretely. Return at most 12 themes.'
    )
    expect(result.findings).toEqual([])
  })
})
