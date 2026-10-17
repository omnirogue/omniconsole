import type {
  LocalWorkflowCallView,
  LocalWorkflowDiscoverFinding,
  LocalWorkflowDiscoverRun,
  LocalWorkflowDiscoverSeverity,
  LocalWorkflowDiscoverVerdict,
  LocalWorkflowSeatView,
  LocalWorkflowView
} from '../../../shared/local-workflow-view'
import { localWorkflowModelLabel } from '../../../shared/local-workflow-model-label'
import type { WorkflowProgramSnapshot } from './workflow-execution-service'

type LegacyFinding = NonNullable<LocalWorkflowView['findings']>[number]
type LegacyRanking = {
  summary: string
  ranking: { findingId: string; reason: string; nextAction: string }[]
}

const SEVERITIES: readonly LocalWorkflowDiscoverSeverity[] = ['low', 'medium', 'high', 'critical']
const STATUS: Record<string, LocalWorkflowDiscoverFinding['status']> = {
  survives: 'confirmed',
  contested: 'confirmed',
  refuted: 'refuted',
  'insufficient-evidence': 'unverified',
  unresolved: 'verifying'
}
const VERDICT: Record<string, LocalWorkflowDiscoverVerdict> = {
  survives: 'real',
  refuted: 'refuted',
  uncertain: 'unjudged'
}

function seatView(snapshot: WorkflowProgramSnapshot, index: number): LocalWorkflowSeatView {
  const seat = snapshot.seats[index]
  return {
    seatId: seat?.id ?? '',
    agent: seat?.agent ?? 'claude',
    model: seat?.model ?? '',
    modelLabel: seat ? localWorkflowModelLabel(seat.agent, seat.model) : '',
    effort: seat?.effort ?? null
  }
}

/** Legacy findings carry severity and location only inside their markdown. */
function field(markdown: string, name: string): string {
  return new RegExp(`^${name}: (.*)$`, 'm').exec(markdown)?.[1]?.trim() ?? ''
}

function mapFinding(
  snapshot: WorkflowProgramSnapshot,
  finding: LegacyFinding,
  statusOf: ReadonlyMap<string, LocalWorkflowDiscoverFinding['status']>
): LocalWorkflowDiscoverFinding {
  const severity = field(finding.markdown, 'Severity') as LocalWorkflowDiscoverSeverity
  const duplicateOf =
    finding.disposition === 'duplicate'
      ? /duplicate of (\S+?)\.?$/m.exec(finding.markdown)?.[1]
      : undefined
  const status = duplicateOf
    ? (statusOf.get(duplicateOf) ?? 'unverified')
    : (STATUS[finding.disposition] ?? 'unverified')
  return {
    id: finding.id,
    title: finding.label,
    location: field(finding.markdown, 'Location'),
    severity: SEVERITIES.includes(severity) ? severity : 'medium',
    lens: '',
    area: '',
    round: 1,
    foundBy: seatView(snapshot, 0),
    markdown: finding.markdown,
    status,
    votes: finding.verdicts.map((verdict, index) => ({
      lens: verdict.label,
      seat: seatView(snapshot, index + 1),
      state: verdict.verdict === 'unresolved' ? 'pending' : 'done',
      ...(VERDICT[verdict.verdict] ? { verdict: VERDICT[verdict.verdict] } : {}),
      reason: verdict.markdown
    })),
    ...(duplicateOf ? { duplicateOf } : {})
  }
}

/**
 * Best-effort view of revisions 1-6 in the revision 7 shape. It never throws: a legacy ledger
 * problem leaves the rest of the view intact.
 */
export function projectLegacyDiscoverRun(
  snapshot: WorkflowProgramSnapshot,
  results: ReadonlyMap<string, unknown>,
  calls: readonly LocalWorkflowCallView[],
  evidence: Pick<LocalWorkflowView, 'findings'> | undefined
): LocalWorkflowDiscoverRun {
  const config = snapshot.discover
  const run: LocalWorkflowDiscoverRun = {
    areas: (config?.dimensions ?? []).map((name) => ({ name, files: [], why: '' })),
    lenses: [...(config?.lenses ?? [])],
    round: calls.some((call) => call.stageId === 'discover') ? 1 : 0,
    maxRounds: 1,
    findings: [],
    counts: { found: 0, duplicates: 0, verifying: 0, confirmed: 0, refuted: 0, unverified: 0 },
    dropped: []
  }
  try {
    const statusOf = new Map<string, LocalWorkflowDiscoverFinding['status']>()
    const findings = (evidence?.findings ?? []).map((finding) => {
      const mapped = mapFinding(snapshot, finding, statusOf)
      statusOf.set(mapped.id, mapped.status)
      return mapped
    })
    const distinct = findings.filter((finding) => !finding.duplicateOf)
    const count = (status: LocalWorkflowDiscoverFinding['status']) =>
      distinct.filter((finding) => finding.status === status).length
    const skipped = (disposition: string) =>
      (evidence?.findings ?? []).filter((finding) => finding.disposition === disposition).length
    const dropped = [
      [skipped('below threshold'), 'below the minimum severity'],
      [skipped('over candidate limit'), 'over the candidate limit']
    ] as const
    const ranking = results.get('rank/final') as LegacyRanking | undefined
    const byId = new Map(findings.map((finding) => [finding.id, finding]))
    return {
      ...run,
      findings,
      counts: {
        found: findings.length,
        duplicates: findings.length - distinct.length,
        verifying: count('verifying'),
        confirmed: count('confirmed'),
        refuted: count('refuted'),
        unverified: count('unverified')
      },
      ...(ranking
        ? {
            report: {
              summary: ranking.summary,
              items: ranking.ranking.map((item, index) => ({
                rank: index + 1,
                title: byId.get(item.findingId)?.title ?? item.findingId,
                location: byId.get(item.findingId)?.location ?? '',
                severity: byId.get(item.findingId)?.severity ?? 'medium',
                scenario: item.reason,
                fix: item.nextAction,
                findingIds: [item.findingId],
                parallelSafe: false
              }))
            }
          }
        : {}),
      dropped: dropped
        .filter(([total]) => total > 0)
        .map(([total, reason]) => `${total} findings ${reason} were not verified.`)
    }
  } catch {
    return run
  }
}
