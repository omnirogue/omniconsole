import type { AuditSnapshot } from './audit/audit-snapshot'
import {
  auditCritiqueIsConsistent,
  auditReportCritique,
  auditReviewedMarkdown
} from './audit/audit-report-review'

const STAGES = [
  ['read', 'Read sources'],
  ['cluster', 'Group findings'],
  ['agreement', 'Compare readers'],
  ['novelty', 'Find omissions'],
  ['verify', 'Check evidence and impact'],
  ['plan', 'Propose improvements'],
  ['judge', 'Compare plans'],
  ['report', 'Write and review report']
] as const

export function auditStageId(callId: string): string {
  const kind = callId.split('/')[1]
  const stage =
    kind === 'merge'
      ? 'cluster'
      : kind === 'reread'
        ? 'agreement'
        : kind === 'novelty-merge'
          ? 'novelty'
          : ['synthesize', 'critic', 'revise'].includes(kind)
            ? 'report'
            : kind
  return `audit-${stage}`
}

export function auditCallSeatId(audit: AuditSnapshot, callId: string): string | undefined {
  const [, kind, index] = callId.split('/')
  switch (kind) {
    case 'read':
    case 'novelty':
      return audit.readerSeatId
    case 'agreement':
      return audit.judgeSeatIds[0]
    case 'plan':
      return audit.plannerSeatIds[Number(index)]
    case 'judge':
      return audit.judgeSeatIds[Number(index)]
    case 'synthesize':
    case 'revise':
      return audit.synthesizerSeatId
    case 'cluster':
    case 'merge':
    case 'reread':
    case 'novelty-merge':
    case 'verify':
    case 'critic':
      return audit.reviewerSeatId
    default:
      return undefined
  }
}

export function auditStageDefinitions(audit: AuditSnapshot, results: ReadonlyMap<string, unknown>) {
  const critic = results.get('audit/critic') as { verdict?: string } | undefined
  const themes = results.get('audit/novelty-merge') ?? results.get('audit/merge')
  const findings = themes as { findings?: unknown[] } | undefined
  const totals: Record<string, number | undefined> = {
    read: audit.corpus.chunks.length,
    cluster: Math.min(audit.clusterGroups, audit.corpus.chunks.length) + 1,
    agreement: audit.agreementSamples * 2,
    novelty: audit.noveltyLenses.length ? Math.ceil(audit.corpus.chunks.length / 2) + 1 : 0,
    verify: findings?.findings ? findings.findings.length * 3 : undefined,
    plan: audit.plannerSeatIds.length,
    judge: audit.judgeSeatIds.length,
    report: critic?.verdict === 'revise' ? 3 : 2
  }
  return STAGES.filter(([id]) => totals[id] !== 0).map(([id, label]) => ({
    id: `audit-${id}`,
    label,
    ...(totals[id] === undefined ? {} : { total: totals[id] })
  }))
}

/** A required revision can never fall back to the superseded synthesis. */
export function auditResultMarkdown(
  results: ReadonlyMap<string, unknown>,
  revision: AuditSnapshot['version'] = 1
): string | undefined {
  const critic = results.get('audit/critic') as { verdict?: string } | undefined
  if (!critic || !['ready', 'revise'].includes(critic.verdict ?? '')) {
    return undefined
  }
  const result = results.get(critic.verdict === 'revise' ? 'audit/revise' : 'audit/synthesize') as
    | { markdown?: unknown }
    | undefined
  if (typeof result?.markdown !== 'string') {
    return undefined
  }
  if (revision === 1) {
    return result.markdown
  }
  const review = auditReportCritique(critic)
  if (!review || !auditCritiqueIsConsistent(review) || !result.markdown.trim()) {
    return undefined
  }
  return auditReviewedMarkdown(result.markdown, review, revision)
}
