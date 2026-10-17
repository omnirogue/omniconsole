import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkflowExecutionService } from '../workflow-execution-service'
import { WorkflowScriptSlots } from '../workflow-script-slots'
import { auditDurableFixture } from './audit-durable.test-fixture'
import { runAuditProgram } from './audit-program'
import type { AuditSnapshot } from './audit-snapshot'
import { buildAuditCorpus } from './audit-corpus'
import type { AuditFinding } from '../../../../shared/workflow-audit-contracts'

const fixtures: ReturnType<typeof auditDurableFixture>[] = []
const fixture = (...args: Parameters<typeof auditDurableFixture>) => {
  const value = auditDurableFixture(...args)
  fixtures.push(value)
  return value
}
afterEach(() => {
  fixtures.splice(0).forEach((item) => item.close())
})

describe('audit stage failure boundaries', () => {
  it('exhausts a missing reader and fails the run before synthesis instead of partial success', async () => {
    const f = fixture((call, value) => (call.id === 'audit/read/chunk-0001' ? null : value))
    await expect(runAuditProgram(f.context, f.audit, 'Audit fixture', f.ports)).rejects.toThrow(
      /incomplete/
    )
    expect(f.calls.filter((call) => call.id === 'audit/read/chunk-0001')).toHaveLength(3)
    expect(
      f.calls.some((call) => call.id.startsWith('audit/plan/') || call.id === 'audit/synthesize')
    ).toBe(false)
    expect(
      f.db.db
        .prepare(
          "SELECT accepted_attempt_id FROM local_workflow_calls WHERE call_id = 'audit/read/chunk-0001'"
        )
        .get()
    ).toEqual({ accepted_attempt_id: null })
  })

  it.each(['missing', 'null', 'nonfinite'] as const)(
    'rejects %s adjustedImpact and fails after bounded retries',
    async (kind) => {
      const f = fixture((call, value) => {
        if (!call.id.endsWith('/impact')) {
          return value
        }
        const { adjustedImpact: _removed, ...rest } = value as Record<string, unknown>
        return kind === 'missing'
          ? rest
          : { ...rest, adjustedImpact: kind === 'null' ? null : Number.POSITIVE_INFINITY }
      })
      await expect(runAuditProgram(f.context, f.audit, 'Audit fixture', f.ports)).rejects.toThrow(
        /incomplete/
      )
      const retries = f.calls.filter((call) => call.id === 'audit/verify/0/impact')
      expect(retries).toHaveLength(3)
      expect(retries[1].problems).toMatch(
        kind === 'missing' ? /must supply adjustedImpact/ : /integer/
      )
      expect(f.calls.some((call) => call.id.startsWith('audit/plan/'))).toBe(false)
    }
  )

  it('retries a missing impact score and continues only after a valid correction', async () => {
    let omitted = false
    const f = fixture((call, value) => {
      if (omitted || call.id !== 'audit/verify/0/impact') {
        return value
      }
      omitted = true
      const { adjustedImpact: _removed, ...rest } = value as Record<string, unknown>
      return rest
    })
    const result = await runAuditProgram(f.context, f.audit, 'Audit fixture', f.ports)
    expect(result.reviewed[0].adjustedImpact).toBe(4)
    expect(f.calls.filter((call) => call.id === 'audit/verify/0/impact')).toHaveLength(2)
    expect(result.revised).toBe(true)
  })

  it.each([4, 5] as const)(
    'gives revision %i the exact missing quote pair and accepts the corrected cluster',
    async (revision) => {
      let rejectFirstCluster = true
      const prompts = new Map<string, string>()
      const f = fixture((call, value) => {
        if (['audit/cluster/0', 'audit/merge', 'audit/novelty-merge'].includes(call.id)) {
          prompts.set(call.id, call.prompt)
        }
        if (call.id !== 'audit/cluster/0') {
          return value
        }
        if (!rejectFirstCluster) {
          return value
        }
        rejectFirstCluster = false
        const cluster = value as { findings: AuditFinding[] }
        return {
          ...cluster,
          findings: cluster.findings.map((finding) => ({
            ...finding,
            evidence: finding.evidence.filter((citation) => citation.quote !== 'setup steps')
          }))
        }
      }, revision)

      const result = await runAuditProgram(f.context, f.audit, 'Audit fixture', f.ports)
      const attempts = f.calls.filter((call) => call.id === 'audit/cluster/0')

      expect(result.version).toBe(revision)
      expect(attempts).toHaveLength(2)
      expect(attempts[1].problems).toContain('missingCount=')
      expect(attempts[1].problems).toContain('"setup steps"')
      for (const callId of ['audit/cluster/0', 'audit/merge', 'audit/novelty-merge']) {
        expect(prompts.get(callId)).toContain('overlap or where one is a substring')
        expect(prompts.get(callId)).toContain(
          'Deduplicate only identical pairs of source ID and full quote'
        )
        expect(prompts.get(callId)).not.toContain('Merge evidence by distinct source IDs')
      }
    }
  )

  it('retains revision 3 cluster prompt and generic omission retry feedback', async () => {
    let v3Prompt = ''
    const f = fixture((call, value) => {
      if (call.id !== 'audit/cluster/0') {
        return value
      }
      v3Prompt = call.prompt
      const cluster = value as { findings: AuditFinding[] }
      return {
        ...cluster,
        findings: cluster.findings.map((finding) => ({
          ...finding,
          evidence: finding.evidence.filter((citation) => citation.quote !== 'setup steps')
        }))
      }
    }, 3)

    await expect(runAuditProgram(f.context, f.audit, 'Audit fixture', f.ports)).rejects.toThrow()
    const attempts = f.calls.filter((call) => call.id === 'audit/cluster/0')

    expect(attempts).toHaveLength(3)
    expect(attempts[1].problems).toContain('Cluster omitted evidence from its inputs')
    expect(attempts[1].problems).not.toContain('missingCount=')
    expect(v3Prompt).toContain('preserving every supplied citation pair exactly')
    expect(v3Prompt).not.toContain('Deduplicate only identical pairs of source ID and full quote')
  })
})

describe('audit admission before provider launch', () => {
  it.each(['revision', 'preset', 'ceiling'] as const)(
    'refuses invalid %s at checkpoint admission',
    (kind) => {
      const f = fixture()
      const launch = vi.fn(() => {
        throw new Error('Must not launch')
      })
      const service = new WorkflowExecutionService({
        store: f.store,
        slots: new WorkflowScriptSlots(1),
        reservation: 1,
        progress: () => {},
        launch: () => launch
      })
      const snapshot = structuredClone(f.snapshot)
      if (kind === 'revision') {
        snapshot.audit!.version = 99 as AuditSnapshot['version']
      }
      expect(() =>
        service.start({
          conversationId: 'invalid',
          requestId: 'invalid',
          snapshot,
          preset: kind === 'preset' ? 'council' : 'discover',
          fence: 1,
          attemptLimit: 3,
          callLimit: kind === 'ceiling' ? 201 : 30,
          budgetLimit: 603
        })
      ).toThrow(
        kind === 'ceiling' ? 'Preset call ceiling exceeded' : 'Unsupported audit workflow snapshot'
      )
      expect(launch).not.toHaveBeenCalled()
    }
  )

  it('refuses fan-out whose calculated calls exceed admission even with a permitted declared limit', async () => {
    const f = fixture()
    const launch = vi.fn(() => {
      throw new Error('Must not launch')
    })
    const service = new WorkflowExecutionService({
      store: f.store,
      slots: new WorkflowScriptSlots(1),
      reservation: 1,
      progress: () => {},
      launch: () => launch
    })
    const snapshot = structuredClone(f.snapshot)
    const audit = snapshot.audit!
    const sources = Array.from({ length: 64 }, (_, index) => ({
      id: `source-${String(index).padStart(2, '0')}`,
      timestamp: '2026-10-02T12:00:00Z',
      text: 'Synthetic'
    }))
    const bound = buildAuditCorpus([sources[0]], { maxChunkBytes: 10_000 }).chunks[0].bytes
    audit.corpus = buildAuditCorpus(sources, { maxChunkBytes: bound })
    audit.clusterGroups = 8
    audit.agreementSamples = 64
    audit.maxThemes = 24
    const id = service.start({
      conversationId: 'fanout',
      requestId: 'fanout',
      snapshot,
      preset: 'discover',
      fence: 1,
      attemptLimit: 3,
      callLimit: 200,
      budgetLimit: 600
    })
    const result = await service.wait(id)
    expect(result.state).toBe('failed')
    expect(result.error).toContain('200-call workflow ceiling')
    expect(launch).not.toHaveBeenCalled()
  })
})
