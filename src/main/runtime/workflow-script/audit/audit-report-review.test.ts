import { afterEach, describe, expect, it } from 'vitest'
import { auditDurableFixture } from './audit-durable.test-fixture'
import { runAuditProgram } from './audit-program'
import { auditResultMarkdown } from '../local-workflow-audit-projection'
import type { WorkflowProgramCall } from '../workflow-program-context'

const fixtures: ReturnType<typeof auditDurableFixture>[] = []
afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.close()))

function captureReportPayloads(
  payloads: Map<string, string>,
  outputs?: Map<string, unknown>,
  prompts?: Map<number, Map<string, string>>
) {
  return (call: WorkflowProgramCall, value: unknown) => {
    if (['audit/judge/0', 'audit/synthesize', 'audit/critic', 'audit/revise'].includes(call.id)) {
      const marker = '\nDATA\n'
      const offset = call.prompt.indexOf(marker)
      payloads.set(call.id, call.prompt.slice(offset + marker.length))
      if (prompts) {
        const version = Number(call.prompt.match(/Audit workflow v(\d+)/)?.[1] ?? 0)
        const byCall = prompts.get(version) ?? new Map<string, string>()
        byCall.set(call.id, call.prompt)
        prompts.set(version, byCall)
      }
    }
    if (call.id === 'audit/synthesize') {
      outputs?.set(call.id, value)
    }
    return value
  }
}

function dataFor(payloads: Map<string, string>, callId: string) {
  return JSON.parse(payloads.get(callId)!) as Record<string, unknown>
}

describe('versioned Audit report review', () => {
  it.each([2, 3, 4, 5] as const)(
    'rejects ready with unresolved concerns in revision %i before accepting a report',
    async (revision) => {
      const f = auditDurableFixture(
        (call, value) =>
          call.id === 'audit/critic'
            ? { verdict: 'ready', gaps: ['A request is missing'], unsupportedClaims: [] }
            : value,
        revision
      )
      fixtures.push(f)
      await expect(runAuditProgram(f.context, f.audit, 'Audit fixture', f.ports)).rejects.toThrow()
      const critics = f.calls.filter((call) => call.id === 'audit/critic')
      expect(critics).toHaveLength(3)
      expect(critics[1].problems).toContain('ready report cannot have unresolved')
      expect(f.calls.some((call) => call.id === 'audit/revise')).toBe(false)
    }
  )

  it.each([2, 3, 4] as const)(
    'keeps revision %i concerns visible without claiming another semantic review',
    async (revision) => {
      const f = auditDurableFixture(
        (call, value) =>
          call.id === 'audit/critic'
            ? { verdict: 'revise', gaps: ['Show missing status'], unsupportedClaims: ['Savings'] }
            : value,
        revision
      )
      fixtures.push(f)
      const result = await runAuditProgram(f.context, f.audit, 'Audit fixture', f.ports)
      expect(result.version).toBe(revision)
      expect(result.final.markdown).toContain('has not received a further semantic review')
      expect(result.final.markdown).toContain('> Gap: Show missing status')
      expect(result.final.markdown).toContain('> Unsupported claim: Savings')
      expect(f.calls).toHaveLength(23)
    }
  )

  it.each([3, 4, 5] as const)(
    'gives revision %i judges, critic and reviser the deterministic report evidence',
    async (revision) => {
      const payloads = new Map<string, string>()
      const outputs = new Map<string, unknown>()
      const f = auditDurableFixture(captureReportPayloads(payloads, outputs), revision)
      fixtures.push(f)

      const result = await runAuditProgram(f.context, f.audit, 'Audit fixture', f.ports)

      expect(result.version).toBe(revision)
      const synthesis = dataFor(payloads, 'audit/synthesize')
      const critic = dataFor(payloads, 'audit/critic')
      const revise = dataFor(payloads, 'audit/revise')
      const judge = dataFor(payloads, 'audit/judge/0')
      const synthesizedReport = outputs.get('audit/synthesize') as { markdown: string }
      const reportFields = ['reviewed', 'plans', 'judges', 'tally', 'winners', 'method']

      expect(Object.keys(judge)).toEqual(['verified', 'plans', 'reviewed', 'method'])
      expect(Object.keys(critic)).toEqual(['report', ...reportFields])
      expect(Object.keys(revise)).toEqual(['report', 'critique', ...reportFields])
      expect(judge.reviewed).toEqual(synthesis.reviewed)
      expect((judge.plans as { plan: unknown }[]).map(({ plan }) => plan)).toEqual(synthesis.plans)
      expect(judge.method).toEqual(synthesis.method)
      expect(synthesis.plans).toHaveLength(3)
      expect(synthesis.judges).toHaveLength(2)
      expect(synthesis.tally).toHaveLength(3)
      expect(synthesis.winners).toEqual(['Plan B'])
      for (const field of reportFields) {
        expect(critic[field]).toEqual(synthesis[field])
        expect(revise[field]).toEqual(synthesis[field])
      }
      expect(revise.report).toBe(synthesizedReport.markdown)
      expect((judge.method as Record<string, unknown>).agreementDefinition).toBe(
        (synthesis.method as Record<string, unknown>).agreementDefinition
      )
      expect(synthesis.method).toMatchObject({
        agreementDefinition:
          'Many-to-many pairs are allowed. Rate = (unique matched A count + unique matched B count) / (total A findings + total B findings). When both readers return zero findings, the rate is undefined (represented as null). Unequal reader counts can still yield 100%; overlap is not accuracy.'
      })
      if (revision === 3) {
        expect(synthesis.method).not.toHaveProperty('readerDefinition')
      } else {
        expect(synthesis.method).toMatchObject({
          readerDefinition:
            'readersCompleted and readersExpected count primary per-chunk reads only. Agreement samples run a separate second reader for selected chunks; those rereads are counted in agreement, not in these reader totals.'
        })
        expect(judge.method).toEqual(synthesis.method)
        expect(critic.method).toEqual(synthesis.method)
        expect(revise.method).toEqual(synthesis.method)
      }
      if (revision === 5) {
        expect(result.final.markdown).toContain('verbatim from before this revision')
        expect(result.final.markdown).toContain('not been rechecked against the revised report')
        expect(result.final.markdown).toContain(
          'does not claim they are resolved or remain current defects'
        )
      } else {
        expect(result.final.markdown).toContain('has not received a further semantic review')
      }
    }
  )

  it('keeps revision 1 and 2 judge, critic and reviser payloads unchanged', async () => {
    const payloadsByRevision = new Map<number, Map<string, string>>()
    for (const revision of [1, 2] as const) {
      const payloads = new Map<string, string>()
      payloadsByRevision.set(revision, payloads)
      const f = auditDurableFixture(captureReportPayloads(payloads), revision)
      fixtures.push(f)
      await runAuditProgram(f.context, f.audit, 'Audit fixture', f.ports)
    }

    const revision1 = payloadsByRevision.get(1)!
    const revision2 = payloadsByRevision.get(2)!
    for (const callId of ['audit/judge/0', 'audit/synthesize', 'audit/critic', 'audit/revise']) {
      expect(revision1.get(callId)).toBe(revision2.get(callId))
    }
    expect(Object.keys(dataFor(revision1, 'audit/judge/0'))).toEqual(['verified', 'plans'])
    expect(Object.keys(dataFor(revision1, 'audit/critic'))).toEqual([
      'report',
      'reviewed',
      'method'
    ])
    expect(Object.keys(dataFor(revision1, 'audit/revise'))).toEqual([
      'report',
      'critique',
      'reviewed',
      'method'
    ])
  })

  it('adds exact-quote and evidence-based critique instructions only in revision 5', async () => {
    const runs = new Map<number, Map<string, string>>()
    for (const revision of [4, 5] as const) {
      const f = auditDurableFixture(captureReportPayloads(new Map(), undefined, runs), revision)
      fixtures.push(f)
      await runAuditProgram(f.context, f.audit, 'Audit fixture', f.ports)
    }
    const v4 = runs.get(4)!
    const v5 = runs.get(5)!
    for (const callId of ['audit/synthesize', 'audit/critic', 'audit/revise']) {
      expect(v4.get(callId)).toBeDefined()
      expect(v5.get(callId)).not.toBe(v4.get(callId))
    }
    expect(v4.get('audit/synthesize')).not.toContain(
      'exact contiguous source text, including capitalization and punctuation'
    )
    expect(v4.get('audit/critic')).not.toContain(
      'exact contiguous wording, capitalization and punctuation'
    )
    expect(v5.get('audit/synthesize')).toContain(
      'exact contiguous source text, including capitalization and punctuation'
    )
    expect(v5.get('audit/critic')).toContain(
      'exact contiguous wording, capitalization and punctuation'
    )
    expect(v5.get('audit/revise')).toContain('do not adopt unsupported critic claims or arithmetic')
  })

  it('does not retroactively change a v1 accepted critic or report', async () => {
    const f = auditDurableFixture((call, value) =>
      call.id === 'audit/critic'
        ? { verdict: 'ready', gaps: ['Legacy concern'], unsupportedClaims: [] }
        : value
    )
    fixtures.push(f)
    const result = await runAuditProgram(f.context, f.audit, 'Audit fixture', f.ports)
    expect(result.version).toBe(1)
    expect(result.revised).toBe(false)
    expect(result.final.markdown).not.toContain('### Review status')
  })

  it('projects the same review status and never promotes a missing or inconsistent revision', () => {
    const results = new Map<string, unknown>([
      ['audit/synthesize', { markdown: 'Old report' }],
      ['audit/critic', { verdict: 'revise', gaps: ['Missing request'], unsupportedClaims: [] }]
    ])
    expect(auditResultMarkdown(results, 2)).toBeUndefined()
    expect(auditResultMarkdown(results, 3)).toBeUndefined()
    expect(auditResultMarkdown(results, 4)).toBeUndefined()
    expect(auditResultMarkdown(results, 5)).toBeUndefined()
    results.set('audit/revise', { markdown: 'Corrected report' })
    expect(auditResultMarkdown(results, 2)).toContain('> Gap: Missing request')
    expect(auditResultMarkdown(results, 3)).toContain('> Gap: Missing request')
    expect(auditResultMarkdown(results, 4)).toContain('> Gap: Missing request')
    expect(auditResultMarkdown(results, 5)).toContain('verbatim from before this revision')
    expect(auditResultMarkdown(results, 5)).toContain('> Gap: Missing request')
    expect(auditResultMarkdown(results, 1)).toBe('Corrected report')
    results.set('audit/critic', {
      verdict: 'ready',
      gaps: ['Still missing'],
      unsupportedClaims: []
    })
    expect(auditResultMarkdown(results, 2)).toBeUndefined()
    expect(auditResultMarkdown(results, 3)).toBeUndefined()
    expect(auditResultMarkdown(results, 4)).toBeUndefined()
    expect(auditResultMarkdown(results, 5)).toBeUndefined()
    expect(auditResultMarkdown(results, 1)).toBe('Old report')
    results.set('audit/critic', { verdict: 'ready', gaps: [], unsupportedClaims: [] })
    expect(auditResultMarkdown(results, 2)).toContain('critic reported no outstanding concerns')
    expect(auditResultMarkdown(results, 3)).toContain('critic reported no outstanding concerns')
    expect(auditResultMarkdown(results, 4)).toContain('critic reported no outstanding concerns')
    expect(auditResultMarkdown(results, 5)).toContain('critic reported no outstanding concerns')
    results.set('audit/critic', { verdict: 'ready' })
    expect(auditResultMarkdown(results, 2)).toBeUndefined()
    expect(auditResultMarkdown(results, 3)).toBeUndefined()
    expect(auditResultMarkdown(results, 4)).toBeUndefined()
    expect(auditResultMarkdown(results, 5)).toBeUndefined()
  })
})
