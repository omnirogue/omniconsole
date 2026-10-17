import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import {
  evolvePromotionRecommended,
  evolveWinnerMetrics
} from '../../../../shared/evolve-decision-metrics'
import type { EvolveRunRecord } from '../../../../shared/evolve-workflow'
import { EvolveCopyText } from './EvolveCopyText'
import { evolveScore, evolveUsd, evolveYesNo } from './evolve-run-text'

export type EvolveDecisionResolutionChoice =
  | 'promote_winner'
  | 'keep_incumbent'
  | 'rerun_higher_budget'

export type EvolveDecisionMetadata = {
  runId: string
  kind: 'discover' | 'evolve'
  winnerCandidateId: string
  winnerDigest: string
  idempotencyKey: string
  decisionId: string
  state: 'pending' | 'published' | 'promoted' | 'kept' | 'rerun' | 'failed'
  resolution?: EvolveDecisionResolutionChoice | null
  resolvedAt?: string | null
  url?: string | null
  baselineScore?: number | null
  challengerScore?: number | null
  heldOutDelta?: number | null
  blindAuditScore?: string | null
  blindAuditPassed?: boolean | null
  creditsSpent?: number | null
  spendUsd?: number | null
  summaryLine?: string
  error?: string | null
  updatedAt: string
}

type RunWithDecision = EvolveRunRecord & {
  decision?: EvolveDecisionMetadata
}

function deriveDecisionMetadata(run: RunWithDecision): EvolveDecisionMetadata | null {
  if (run.decision) {
    return run.decision
  }
  const metrics = evolveWinnerMetrics(run)
  if (!metrics) {
    return null
  }
  return {
    runId: run.id,
    kind: 'evolve',
    ...metrics,
    idempotencyKey: `evolve:${run.id}:${metrics.winnerDigest}`,
    decisionId: `dec_${run.id}_${metrics.winnerDigest.slice(0, 8)}`,
    state: 'pending',
    updatedAt: run.updatedAt
  }
}

function decisionBadgeLabel(
  state: EvolveDecisionMetadata['state'],
  resolution: EvolveDecisionResolutionChoice | null
): string {
  if (resolution === 'promote_winner' || state === 'promoted') {
    return translate('evolveDecision.state.promoted', 'Winner Promoted')
  }
  if (resolution === 'keep_incumbent' || state === 'kept') {
    return translate('evolveDecision.state.kept', 'Incumbent Kept')
  }
  if (state === 'published') {
    return translate('evolveDecision.state.published', 'Published in Decisions')
  }
  if (state === 'failed') {
    return translate('evolveDecision.state.failed', 'Delivery Failed')
  }
  return translate('evolveDecision.state.pending', 'Awaiting Decision')
}

/**
 * Summary-first Evolve Decision review card (Sal, 8 Oct 2026):
 * top summary + key metrics + marked recommended option, with evidence in collapsed details.
 */
export function EvolveDecisionCard({ run }: { run: EvolveRunRecord }) {
  const decision = deriveDecisionMetadata(run as RunWithDecision)
  if (!decision) {
    return null
  }

  // Only what OmniOS or the outbox recorded; this card never decides anything itself.
  const resolution = decision.resolution ?? null
  const recommendPromote = evolvePromotionRecommended({
    blindAuditPassed: decision.blindAuditPassed ?? null
  })
  const publishedUrl =
    typeof decision.url === 'string' && decision.url.startsWith('https://') ? decision.url : null
  const deltaText =
    typeof decision.heldOutDelta === 'number'
      ? `${decision.heldOutDelta >= 0 ? '+' : ''}${decision.heldOutDelta.toFixed(3)}`
      : '—'
  const creditsText =
    typeof decision.creditsSpent === 'number'
      ? translate('evolveDecision.creditsValue', '{{credits}} credits ({{usd}})', {
          credits: decision.creditsSpent,
          usd: evolveUsd(decision.spendUsd)
        })
      : evolveUsd(decision.spendUsd)

  const handleOpenDecisions = () => {
    if (publishedUrl) {
      void window.api?.shell?.openUrl?.(publishedUrl)
    }
  }

  const promos = run.ledger?.promotions ?? []
  const rubrics = run.ledger?.rubrics ?? []

  return (
    <section
      aria-label={translate('evolveDecision.title', 'Evolve Decision')}
      className="space-y-3 rounded-md border bg-card p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold">
            {translate('evolveDecision.title', 'Evolve Decision')}
          </h3>
          <Badge
            variant={
              resolution === 'promote_winner'
                ? 'default'
                : resolution === 'keep_incumbent'
                  ? 'secondary'
                  : 'outline'
            }
          >
            {decisionBadgeLabel(decision.state, resolution)}
          </Badge>
        </div>
        <span className="font-mono text-xs text-muted-foreground">{decision.decisionId}</span>
      </div>

      <p className="text-xs text-foreground">
        {decision.summaryLine ??
          translate(
            'evolveDecision.summaryFallback',
            'Candidate {{candidate}} completed evaluation on {{target}}. Decide whether to promote it as the next compounding seed or keep the current incumbent.',
            {
              candidate: decision.winnerCandidateId,
              target: run.request.target
            }
          )}
      </p>

      <dl className="grid gap-2 rounded-md border bg-muted/20 p-2.5 text-xs sm:grid-cols-4">
        <div>
          <dt className="text-muted-foreground">
            {translate('evolveDecision.challengerVsBaseline', 'Challenger vs Baseline')}
          </dt>
          <dd className="mt-0.5 font-medium tabular-nums">
            {evolveScore(decision.challengerScore)}{' '}
            <span className="text-muted-foreground">
              {translate('evolveDecision.vs', 'vs')} {evolveScore(decision.baselineScore)}
            </span>
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">
            {translate('evolveDecision.heldOutDelta', 'Held-out delta')}
          </dt>
          <dd className="mt-0.5 font-medium tabular-nums">{deltaText}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">
            {translate('evolveDecision.blindAudit', 'Blind cross-family audit')}
          </dt>
          <dd className="mt-0.5 font-medium">{decision.blindAuditScore ?? '—'}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">
            {translate('evolveDecision.creditsSpent', 'Credits spent')}
          </dt>
          <dd className="mt-0.5 font-medium tabular-nums">{creditsText}</dd>
        </div>
      </dl>

      <p className="text-xs text-foreground">
        {recommendPromote
          ? translate(
              'evolveDecision.recommendPromote',
              'Recommended: promote winning version {{candidate}}.',
              { candidate: decision.winnerCandidateId }
            )
          : translate(
              'evolveDecision.recommendKeep',
              'Recommended: keep the current incumbent; the promotion gate recorded no pass for {{candidate}}.',
              { candidate: decision.winnerCandidateId }
            )}
      </p>

      {publishedUrl ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={handleOpenDecisions}>
            {translate('evolveDecision.openInDecisions', 'Open in Decisions')}
          </Button>
          <span className="text-xs text-muted-foreground">
            {translate(
              'evolveDecision.decideThere',
              'Decide on the OmniOS review page; nothing is promoted automatically.'
            )}
          </span>
        </div>
      ) : (
        <p role="status" className="text-xs text-muted-foreground">
          {decision.state === 'failed'
            ? translate(
                'evolveDecision.deliveryFailedNotice',
                'Not in OmniOS Decisions yet ({{reason}}); it is tried again later.',
                { reason: decision.error ?? '—' }
              )
            : translate(
                'evolveDecision.notPublished',
                'Not in OmniOS Decisions yet; nothing is promoted until it is decided there.'
              )}
        </p>
      )}

      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground">
          {translate(
            'evolveDecision.evidenceToggle',
            'Decision evidence, candidate digest & rubric lineage'
          )}
        </summary>
        <div className="mt-2 space-y-2 rounded-md border bg-muted/30 p-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground">
              {translate('evolveDecision.winnerCandidate', 'Winning candidate')}:
            </span>
            <EvolveCopyText
              value={decision.winnerCandidateId}
              label={translate('evolveDecision.winnerCandidate', 'Winning candidate')}
            />
            <span className="text-muted-foreground">
              {translate('evolveDecision.winnerDigest', 'Program SHA')}:
            </span>
            <EvolveCopyText
              value={decision.winnerDigest}
              shown={decision.winnerDigest.slice(0, 12)}
              label={translate('evolveDecision.winnerDigest', 'Program SHA')}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground">
              {translate('evolveDecision.idempotencyKey', 'Outbox key')}:
            </span>
            <EvolveCopyText
              value={decision.idempotencyKey}
              label={translate('evolveDecision.idempotencyKey', 'Outbox key')}
            />
          </div>
          {promos.length > 0 && (
            <p className="text-muted-foreground">
              {translate(
                'evolveDecision.promotionGateSummary',
                'Promotion gate: {{decision}} · hard pass {{hard}} · intervals pass {{intervals}}',
                {
                  decision: promos[0].decision,
                  hard: evolveYesNo(promos[0].hard_pass),
                  intervals: evolveYesNo(promos[0].intervals_pass)
                }
              )}
            </p>
          )}
          {rubrics.length > 0 && (
            <p className="text-muted-foreground">
              {translate('evolveDecision.rubricCount', '{{count}} frozen rubric(s) verified', {
                count: rubrics.length
              })}
            </p>
          )}
        </div>
      </details>
    </section>
  )
}
