import type { AuditFinding, AuditReader } from '../../../../src/shared/workflow-audit-contracts'
import type { WorkflowProgramCall } from '../../../../src/main/runtime/workflow-script/workflow-program-context'
import type { AuditChunk } from '../../../../src/main/runtime/workflow-script/audit/audit-corpus'

const REPEATED_QUOTE = 'Please stop asking for the same setup steps.'
export const AUDIT_FIXTURE_REVISION =
  '# Revised audit plan\n\nReuse workspace recipes. Status remains unknown pending an independent check.'

function reader(chunk: AuditChunk): AuditReader {
  return {
    version: 1,
    chunkId: chunk.id,
    sourceIds: chunk.sourceIds,
    findings: chunk.sourceIds.flatMap((sourceId) => [
      {
        id: `repeat-${sourceId}`,
        title: 'Repeated setup instructions',
        description: 'Two computers need the same setup instructions again.',
        evidence: [
          { sourceId, quote: REPEATED_QUOTE },
          { sourceId, quote: 'setup steps' }
        ],
        impact: 4,
        proposedFix: 'Save a reusable workspace recipe.'
      },
      ...(sourceId === 'fixture-studio-1'
        ? [
            {
              id: `fabricated-${sourceId}`,
              title: 'Unsupported secret outage',
              description: 'A reader invents a quote to test deterministic evidence rejection.',
              evidence: [{ sourceId, quote: 'Every deployment lost a full day.' }],
              impact: 5,
              proposedFix: 'This finding must be dropped.'
            }
          ]
        : [])
    ])
  }
}

function cluster(findings: AuditFinding[]) {
  const groups = new Map<string, AuditFinding>()
  for (const finding of findings) {
    const id = finding.title === 'Repeated setup instructions' ? 'T-repeat' : 'T-fabricated'
    const merged = groups.get(id) ?? { ...finding, id, evidence: [] }
    for (const citation of finding.evidence) {
      if (
        !merged.evidence.some(
          (item) => item.sourceId === citation.sourceId && item.quote === citation.quote
        )
      ) {
        merged.evidence.push(citation)
      }
    }
    groups.set(id, merged)
  }
  return { version: 1, findings: [...groups.values()] }
}

type FixtureData = {
  chunk: AuditChunk
  findings: AuditFinding[]
  existing: AuditFinding[]
  a: AuditReader
  b: AuditReader
  lens: string
  verified: AuditFinding[]
  plans: { label: string }[]
}

export function auditFixtureResponse(call: WorkflowProgramCall): unknown {
  const marker = '\nDATA\n'
  const offset = call.prompt.indexOf(marker)
  if (offset === -1) {
    throw new Error(`Missing audit DATA frame: ${call.id}`)
  }
  const data = JSON.parse(call.prompt.slice(offset + marker.length)) as FixtureData
  if (/^audit\/(?:read|reread)\//.test(call.id)) {
    return reader(data.chunk)
  }
  if (call.id.startsWith('audit/cluster/') || call.id === 'audit/merge') {
    return cluster(data.findings)
  }
  if (call.id.startsWith('audit/agreement/')) {
    return {
      version: 1,
      matches: data.a.findings.map((finding) => ({
        aId: finding.id,
        bId: finding.id,
        reason: 'The same issue and exact fixture source.'
      }))
    }
  }
  if (call.id.startsWith('audit/novelty/')) {
    return {
      version: 1,
      lens: data.lens,
      existingFindingIds: data.existing.map((finding) => finding.id),
      findings: []
    }
  }
  if (call.id === 'audit/novelty-merge') {
    return cluster(data.existing)
  }
  if (call.id.startsWith('audit/verify/')) {
    return {
      version: 1,
      verdict: call.id.endsWith('/status') ? 'unknown' : 'confirmed',
      reason:
        'Fixture judges confirm; deterministic checking must still reject the fabricated quote.',
      ...(call.id.endsWith('/impact') ? { adjustedImpact: 4 } : {}),
      ...(call.id.endsWith('/status') ? { status: 'unknown' } : {})
    }
  }
  if (call.id.startsWith('audit/plan/')) {
    return {
      title: 'Reuse workspace setup',
      initiatives: data.verified.map((finding) => ({
        themeIds: [finding.id],
        change: finding.proposedFix,
        owner: 'Fixture team',
        effort: 'S',
        expectedGain: 'Fewer repeated instructions',
        metric: 'Repeated setup requests',
        firstStep: 'Capture the existing setup recipe.'
      })),
      sequence: ['Capture the recipe', 'Try the recipe on both computers'],
      metrics: ['Repeated setup requests'],
      risks: ['Current implementation status is unknown.']
    }
  }
  if (call.id.startsWith('audit/judge/')) {
    return {
      scores: data.plans.map(({ label }) => {
        const score = label === 'Plan B' ? 9 : label === 'Plan A' ? 6 : 5
        return {
          label,
          grounding: score,
          leverage: score,
          feasibility: score,
          specificity: score,
          reasoning: 'Deterministic fixture ranking.'
        }
      }),
      graft: []
    }
  }
  if (call.id === 'audit/synthesize') {
    return { markdown: '# Initial audit plan\n\nReuse workspace recipes.' }
  }
  if (call.id === 'audit/critic') {
    return {
      verdict: 'revise',
      gaps: ['State that current status is unknown.'],
      unsupportedClaims: []
    }
  }
  if (call.id === 'audit/revise') {
    return { markdown: AUDIT_FIXTURE_REVISION }
  }
  throw new Error(`Unimplemented fixture stage: ${call.id}`)
}
