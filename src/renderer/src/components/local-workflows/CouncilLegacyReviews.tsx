import { translate } from '@/i18n/i18n'
import type { LocalWorkflowView } from '../../../../shared/local-workflow-view'

type LegacyCouncil = NonNullable<LocalWorkflowView['council']>

function CombinedRanking({ ranking }: { ranking: LegacyCouncil['ranking'] }) {
  const label = translate('localWorkflow.combinedRanking', 'Combined peer ranking')
  return (
    <section aria-label={label} className="space-y-2">
      <h4 className="text-xs font-medium text-muted-foreground">{label}</h4>
      <div className="overflow-x-auto scrollbar-sleek">
        <table className="w-full border-collapse text-left text-sm">
          <thead className="text-xs text-muted-foreground">
            <tr className="border-b">
              <th className="py-1.5 pr-3 font-medium">
                {translate('localWorkflow.response', 'Response')}
              </th>
              <th className="py-1.5 pr-3 font-medium">
                {translate('localWorkflow.model', 'Model')}
              </th>
              <th className="py-1.5 pr-3 font-medium">
                {translate('localWorkflow.normalizedRank', 'Normalized rank ↓')}
              </th>
              <th className="py-1.5 font-medium">{translate('localWorkflow.votes', 'Votes')}</th>
            </tr>
          </thead>
          <tbody>
            {ranking.map((entry) => (
              <tr key={entry.label} className="border-b last:border-0">
                <td className="py-1.5 pr-3">{entry.label}</td>
                <td className="py-1.5 pr-3">{entry.model}</td>
                <td className="py-1.5 pr-3 tabular-nums">{entry.score.toFixed(2)}</td>
                <td className="py-1.5 tabular-nums">{entry.votes}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        {translate(
          'localWorkflow.rankingCaveat',
          'Peer opinion, not proof. Ties stay tied; lower normalized rank is better.'
        )}
      </p>
    </section>
  )
}

/**
 * Council revisions 1-5 reviewed differently: each model ranked only the two answers it did not
 * write. Shown as recorded until the host maps those runs onto the current street cred view.
 */
export function CouncilLegacyReviews({ council }: { council: LegacyCouncil }) {
  return (
    <div className="space-y-4">
      {council.ranking.length > 0 && <CombinedRanking ranking={council.ranking} />}
      <ul className="space-y-3">
        {council.reviews.map((review) => (
          <li key={review.reviewer} className="space-y-1.5">
            <p className="text-sm font-medium">
              {translate(
                'localWorkflow.reviewerAssessed',
                '{{reviewer}} assessed the other two answers',
                { reviewer: review.reviewer }
              )}
            </p>
            <ol className="list-decimal space-y-1 pl-5 text-sm">
              {review.ranking.map((label) => {
                const assessment = review.assessments.find((entry) => entry.label === label)
                return (
                  <li key={label}>
                    <span className="font-medium">{label}</span>
                    {assessment ? (
                      <span className="block text-muted-foreground">
                        {translate('localWorkflow.strengths', 'Strengths:')} {assessment.strengths}{' '}
                        {translate('localWorkflow.weaknesses', 'Weaknesses:')}{' '}
                        {assessment.weaknesses}
                      </span>
                    ) : null}
                  </li>
                )
              })}
            </ol>
          </li>
        ))}
      </ul>
    </div>
  )
}
