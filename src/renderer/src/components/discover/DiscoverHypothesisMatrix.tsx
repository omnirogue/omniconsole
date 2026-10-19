import { useId, useMemo, useState } from 'react'
import { ArrowDownWideNarrow } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  DISCOVER_HYPOTHESIS_FILTERS,
  buildDiscoverHypothesisMatrixRows,
  isSameDiscoverCell,
  resolveDiscoverHypothesisMatrixLabels,
  summarizeDiscoverLensCoverage,
  uniqueDiscoverEntries,
  type DiscoverHypothesis,
  type DiscoverHypothesisCell,
  type DiscoverHypothesisCellSelection,
  type DiscoverHypothesisFilter,
  type DiscoverHypothesisLens,
  type DiscoverHypothesisMatrixLabelOverrides,
  type DiscoverHypothesisMatrixLabels,
  type DiscoverHypothesisSort,
  type DiscoverHypothesisVerdict
} from './discover-hypothesis-matrix-helpers'

export type DiscoverHypothesisMatrixProps = {
  hypotheses: readonly DiscoverHypothesis[]
  lenses: readonly DiscoverHypothesisLens[]
  labels?: DiscoverHypothesisMatrixLabelOverrides
  selectedCell?: DiscoverHypothesisCellSelection | null
  onSelectCell?: (selection: DiscoverHypothesisCellSelection) => void
  initialFilter?: DiscoverHypothesisFilter
  initialSort?: DiscoverHypothesisSort
  className?: string
}

const VERDICT_CLASS: Record<DiscoverHypothesisVerdict, string> = {
  supported: 'border-status-success-border bg-status-success-background text-status-success',
  mixed: 'border-status-warning-border bg-status-warning-background text-status-warning',
  refuted: 'border-destructive/40 bg-destructive/10 text-destructive',
  untested: 'border-border bg-transparent text-muted-foreground'
}

const CONFIDENCE_BAR_CLASS: Record<DiscoverHypothesisVerdict, string> = {
  supported: 'bg-status-success',
  mixed: 'bg-status-warning',
  refuted: 'bg-destructive',
  untested: 'bg-muted-foreground'
}

type MatrixCellProps = {
  hypothesis: DiscoverHypothesis
  lens: DiscoverHypothesisLens
  cell: DiscoverHypothesisCell
  labels: DiscoverHypothesisMatrixLabels
  selected: boolean
  onSelectCell?: (selection: DiscoverHypothesisCellSelection) => void
}

function DiscoverHypothesisMatrixCell({
  hypothesis,
  lens,
  cell,
  labels,
  selected,
  onSelectCell
}: MatrixCellProps) {
  const verdict = labels.verdicts[cell.verdict]
  const evidence = labels.evidence(cell.evidenceCount ?? 0)
  const accessibleName = labels.cell({
    hypothesis: hypothesis.statement,
    lens: lens.name,
    verdict,
    evidence
  })
  const content = (
    <>
      <span
        className={cn(
          'inline-flex rounded-full border px-2 py-0.5 text-xs font-medium',
          VERDICT_CLASS[cell.verdict]
        )}
      >
        {verdict}
      </span>
      {cell.verdict !== 'untested' && (
        <span className="text-[11px] text-muted-foreground">{evidence}</span>
      )}
    </>
  )
  if (!onSelectCell) {
    return (
      <div className="flex flex-col items-start gap-1" aria-label={accessibleName} role="group">
        {content}
      </div>
    )
  }
  return (
    <button
      type="button"
      aria-label={accessibleName}
      aria-pressed={selected}
      data-verdict={cell.verdict}
      className={cn(
        'flex w-full flex-col items-start gap-1 rounded-md p-1 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50',
        selected && 'bg-accent ring-1 ring-ring'
      )}
      onClick={() => onSelectCell({ hypothesisId: hypothesis.id, lensId: lens.id })}
    >
      {content}
    </button>
  )
}

type ConfidenceProps = {
  confidence: number | null
  verdict: DiscoverHypothesisVerdict
  labels: DiscoverHypothesisMatrixLabels
}

function DiscoverHypothesisConfidence({ confidence, verdict, labels }: ConfidenceProps) {
  if (confidence === null) {
    return <span className="text-xs text-muted-foreground">{labels.untestedConfidence}</span>
  }
  return (
    <div className="flex min-w-20 flex-col gap-1">
      <span className="text-xs font-medium tabular-nums">{labels.confidence(confidence)}</span>
      <div className="h-1 w-full overflow-hidden rounded-full bg-muted" aria-hidden="true">
        <div
          className={cn('h-full rounded-full', CONFIDENCE_BAR_CLASS[verdict])}
          style={{ width: `${confidence}%` }}
        />
      </div>
    </div>
  )
}

export function DiscoverHypothesisMatrix({
  hypotheses,
  lenses,
  labels: labelOverrides,
  selectedCell,
  onSelectCell,
  initialFilter = 'all',
  initialSort = 'original',
  className
}: DiscoverHypothesisMatrixProps) {
  const headingId = useId()
  const [filter, setFilter] = useState<DiscoverHypothesisFilter>(initialFilter)
  const [sort, setSort] = useState<DiscoverHypothesisSort>(initialSort)
  const labels = useMemo(
    () => resolveDiscoverHypothesisMatrixLabels(labelOverrides),
    [labelOverrides]
  )
  const uniqueHypotheses = useMemo(() => uniqueDiscoverEntries(hypotheses), [hypotheses])
  const uniqueLenses = useMemo(() => uniqueDiscoverEntries(lenses), [lenses])
  const rows = useMemo(
    () => buildDiscoverHypothesisMatrixRows(uniqueHypotheses, uniqueLenses, { filter, sort }),
    [uniqueHypotheses, uniqueLenses, filter, sort]
  )
  const coverage = useMemo(
    () => summarizeDiscoverLensCoverage(uniqueHypotheses, uniqueLenses),
    [uniqueHypotheses, uniqueLenses]
  )

  if (uniqueHypotheses.length === 0) {
    return (
      <section aria-labelledby={headingId} className={cn('flex flex-col gap-2', className)}>
        <h3 id={headingId} className="text-sm font-semibold">
          {labels.heading}
        </h3>
        <p className="text-xs text-muted-foreground">{labels.emptyMatrix}</p>
      </section>
    )
  }

  return (
    <section aria-labelledby={headingId} className={cn('flex flex-col gap-3', className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={headingId} className="text-sm font-semibold">
          {labels.heading}
        </h3>
        <Button
          type="button"
          size="xs"
          variant={sort === 'confidence' ? 'secondary' : 'ghost'}
          aria-pressed={sort === 'confidence'}
          onClick={() => setSort(sort === 'confidence' ? 'original' : 'confidence')}
        >
          <ArrowDownWideNarrow aria-hidden="true" />
          {labels.sortByConfidence}
        </Button>
      </div>
      <div role="group" aria-label={labels.filterGroup} className="flex flex-wrap gap-1">
        {DISCOVER_HYPOTHESIS_FILTERS.map((option) => (
          <Button
            key={option}
            type="button"
            size="xs"
            variant={filter === option ? 'secondary' : 'ghost'}
            aria-pressed={filter === option}
            onClick={() => setFilter(option)}
          >
            {option === 'all' ? labels.filterAll : labels.verdicts[option]}
          </Button>
        ))}
      </div>
      <p role="status" aria-live="polite" className="text-xs text-muted-foreground">
        {labels.shown(rows.length, uniqueHypotheses.length)}
      </p>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">{labels.emptyFilter}</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full border-collapse text-left text-xs" aria-labelledby={headingId}>
            <thead className="bg-muted/40 text-muted-foreground">
              <tr>
                <th scope="col" className="min-w-48 p-2 font-medium">
                  {labels.hypothesisColumn}
                </th>
                {uniqueLenses.map((lens) => (
                  <th key={lens.id} scope="col" className="min-w-28 p-2 font-medium">
                    {lens.name}
                  </th>
                ))}
                <th scope="col" className="p-2 font-medium">
                  {labels.confidenceColumn}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.hypothesis.id}
                  data-verdict={row.verdict}
                  className="border-t border-border align-top"
                >
                  <th scope="row" className="p-2 font-normal text-foreground">
                    {row.hypothesis.statement}
                  </th>
                  {row.cells.map(({ lens, cell }) => (
                    <td key={lens.id} className="p-1">
                      <DiscoverHypothesisMatrixCell
                        hypothesis={row.hypothesis}
                        lens={lens}
                        cell={cell}
                        labels={labels}
                        selected={isSameDiscoverCell(selectedCell, row.hypothesis.id, lens.id)}
                        onSelectCell={onSelectCell}
                      />
                    </td>
                  ))}
                  <td className="p-2">
                    <DiscoverHypothesisConfidence
                      confidence={row.confidence}
                      verdict={row.verdict}
                      labels={labels}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
            {uniqueLenses.length > 0 && (
              <tfoot className="border-t border-border text-muted-foreground">
                <tr>
                  <th scope="row" className="p-2 font-medium">
                    {labels.coverageRow}
                  </th>
                  {coverage.map((entry) => (
                    <td key={entry.lensId} className="p-2">
                      <Badge variant="outline" className="tabular-nums">
                        {labels.coverage(entry.tested, entry.total)}
                      </Badge>
                    </td>
                  ))}
                  <td aria-hidden="true" />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
    </section>
  )
}
