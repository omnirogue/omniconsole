import type { ReactNode } from 'react'
import { translate } from '@/i18n/i18n'
import type { EvolveLedgerStatus } from '../../../../shared/evolve-workflow'
import { EvolveCopyText } from './EvolveCopyText'
import { evolveScore, evolveYesNo } from './evolve-run-text'

function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-md border scrollbar-sleek">
      <table className="w-full text-left text-xs">
        <thead className="bg-muted/40 text-muted-foreground">
          <tr>
            {head.map((cell) => (
              <th key={cell} scope="col" className="px-2 py-1.5 font-medium whitespace-nowrap">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y">{children}</tbody>
      </table>
    </div>
  )
}

const cell = 'px-2 py-1.5 align-top'
const mono = `${cell} font-mono`

/** What this run built on (seeds, rubrics) and what it may hand on (promotion records). */
export function EvolveCompounding({ ledger }: { ledger: EvolveLedgerStatus }) {
  const seeded = ledger.seeded ?? []
  const rubrics = ledger.rubrics ?? []
  const promotions = ledger.promotions ?? []
  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold">{translate('evolve.compounding', 'Compounding')}</h3>
      <p className="text-xs">
        <span className="text-muted-foreground">
          {translate('evolve.seededFrom', 'Seeded from')}:{' '}
        </span>
        {ledger.seed_from ?? translate('evolve.noSeed', 'nothing (no seed-from)')}
      </p>
      {seeded.length > 0 && (
        <Table
          head={[
            translate('evolve.seed.sourceRun', 'Source run'),
            translate('evolve.seed.sourceCandidate', 'Source candidate'),
            translate('evolve.seed.priorScore', 'Prior score'),
            translate('evolve.seed.promoted', 'Promoted before'),
            translate('evolve.seed.score', 'Score on this run'),
            translate('evolve.seed.status', 'Status')
          ]}
        >
          {seeded.map((seed) => (
            <tr key={seed.candidate_id}>
              <td className={mono}>{seed.source_run_id ?? '—'}</td>
              <td className={mono}>{seed.source_candidate_id ?? '—'}</td>
              <td className={cell}>{evolveScore(seed.prior_combined_score)}</td>
              <td className={cell}>{evolveYesNo(seed.prior_promoted)}</td>
              <td className={cell}>{evolveScore(seed.combined_score)}</td>
              <td className={cell}>{seed.status}</td>
            </tr>
          ))}
        </Table>
      )}
      <div className="space-y-1 text-xs">
        <p>
          <span className="text-muted-foreground">
            {translate('evolve.rubricFrom', 'Rubric from')}:{' '}
          </span>
          {ledger.rubric_from ?? translate('evolve.noRubricFrom', 'the spec’s own')}
        </p>
        {rubrics.length > 0 && (
          <ul className="flex flex-wrap gap-2">
            {rubrics.map((rubric) => (
              <li key={`${rubric.stage}-${rubric.rubric_sha}`} className="flex items-center gap-1">
                <span className="text-muted-foreground">
                  {rubric.stage ?? translate('evolve.rubricNoStage', 'rubric')}
                </span>
                <EvolveCopyText
                  value={rubric.rubric_sha}
                  shown={rubric.rubric_sha.slice(0, 12)}
                  label={translate('evolve.rubricSha', 'rubric sha')}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="space-y-2">
        <h4 className="text-xs font-semibold">{translate('evolve.promotions', 'Promotions')}</h4>
        {promotions.length > 0 ? (
          <Table
            head={[
              translate('evolve.promotion.candidate', 'Candidate'),
              translate('evolve.promotion.decision', 'Decision'),
              translate('evolve.promotion.hardPass', 'Hard pass'),
              translate('evolve.promotion.intervalsPass', 'Intervals pass'),
              translate('evolve.promotion.availability', 'Availability')
            ]}
          >
            {promotions.map((promotion) => (
              <tr key={`${promotion.candidate_id}-${promotion.created_at ?? ''}`}>
                <td className={mono}>{promotion.candidate_id}</td>
                <td className={cell}>{promotion.decision}</td>
                <td className={cell}>{evolveYesNo(promotion.hard_pass)}</td>
                <td className={cell}>{evolveYesNo(promotion.intervals_pass)}</td>
                <td className={cell}>{evolveScore(promotion.availability)}</td>
              </tr>
            ))}
          </Table>
        ) : (
          <p className="text-xs text-muted-foreground">
            {translate('evolve.noPromotions', 'No promotion records yet.')}
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          {translate(
            'evolve.promotionNote',
            'An eligible promotion record never deploys anything.'
          )}
        </p>
      </div>
    </section>
  )
}
