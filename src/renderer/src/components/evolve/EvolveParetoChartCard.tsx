import { useId, useMemo } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import {
  buildEvolveParetoChart,
  DEFAULT_EVOLVE_PARETO_CHART_LABELS,
  describeEvolveParetoPoint,
  EVOLVE_PARETO_PLOT
} from './evolve-pareto-chart-helpers'
import type {
  EvolveParetoCandidate,
  EvolveParetoChart,
  EvolveParetoChartLabels
} from './evolve-pareto-chart-helpers'

export type EvolveParetoChartCardProps = {
  candidates: readonly EvolveParetoCandidate[]
  labels?: Partial<EvolveParetoChartLabels>
  selectedCandidateId?: string | null
  onCandidateSelect?: (candidate: EvolveParetoCandidate) => void
  className?: string
}

type PlotProps = {
  chart: EvolveParetoChart
  labels: EvolveParetoChartLabels
  selectedCandidateId?: string | null
}

function ParetoPlot({ chart, labels, selectedCandidateId }: PlotProps) {
  const titleId = useId()
  const descriptionId = useId()
  const { width, height, left, right, top, bottom } = EVOLVE_PARETO_PLOT
  const frontierLine = chart.frontier.map((point) => `${point.x},${point.y}`).join(' ')
  return (
    <svg
      role="img"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      viewBox={`0 0 ${width} ${height}`}
      className="w-full text-xs"
    >
      <title id={titleId}>{labels.title}</title>
      <desc id={descriptionId}>{labels.summary(chart.points.length, chart.frontier.length)}</desc>
      {chart.scoreTicks.map((tick, index) => (
        <g key={index}>
          <line
            x1={left}
            x2={right}
            y1={tick.position}
            y2={tick.position}
            className="stroke-border"
          />
          <text
            x={left - 10}
            y={tick.position}
            textAnchor="end"
            dominantBaseline="middle"
            className="fill-muted-foreground tabular-nums"
          >
            {labels.formatScore(tick.value)}
          </text>
        </g>
      ))}
      <path
        d={`M ${left} ${top} V ${bottom} H ${right}`}
        fill="none"
        className="stroke-muted-foreground"
      />
      {chart.costTicks.map((tick, index) => (
        <text
          key={index}
          x={tick.position}
          y={bottom + 20}
          textAnchor={index === chart.costTicks.length - 1 ? 'end' : 'middle'}
          className="fill-muted-foreground tabular-nums"
        >
          {labels.formatCost(tick.value)}
        </text>
      ))}
      <text x={(left + right) / 2} y={height - 10} textAnchor="middle" className="fill-foreground">
        {labels.cost}
      </text>
      <text
        transform={`translate(16 ${(top + bottom) / 2}) rotate(-90)`}
        textAnchor="middle"
        className="fill-foreground"
      >
        {labels.score}
      </text>
      {chart.frontier.length > 1 && (
        <polyline
          points={frontierLine}
          fill="none"
          strokeWidth={2}
          strokeDasharray="4 4"
          className="stroke-foreground"
        />
      )}
      {chart.points.map((point) => (
        <g key={point.candidate.id} data-candidate-id={point.candidate.id}>
          <title>{describeEvolveParetoPoint(point, labels)}</title>
          {point.candidate.id === selectedCandidateId && (
            <circle
              cx={point.x}
              cy={point.y}
              r={10}
              fill="none"
              strokeWidth={2}
              className="stroke-ring"
            />
          )}
          <circle
            cx={point.x}
            cy={point.y}
            r={5}
            strokeWidth={2}
            data-frontier={point.onFrontier}
            className={
              point.onFrontier
                ? 'fill-foreground stroke-foreground'
                : 'fill-card stroke-muted-foreground'
            }
          />
        </g>
      ))}
    </svg>
  )
}

/** Presentational only: the caller supplies measured candidates and controls selection. */
export function EvolveParetoChartCard({
  candidates,
  labels: labelOverrides,
  selectedCandidateId,
  onCandidateSelect,
  className
}: EvolveParetoChartCardProps) {
  const titleId = useId()
  const descriptionId = useId()
  const labels = { ...DEFAULT_EVOLVE_PARETO_CHART_LABELS, ...labelOverrides }
  const chart = useMemo(() => buildEvolveParetoChart(candidates), [candidates])
  return (
    <Card
      role="region"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      className={cn('min-w-0 gap-3 py-3 shadow-none', className)}
    >
      <CardHeader className="gap-1 px-3">
        <h3 id={titleId} className="text-sm font-semibold">
          {labels.title}
        </h3>
        <CardDescription id={descriptionId} className="text-xs">
          {labels.description}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 px-3">
        {chart.points.length === 0 ? (
          <p role="status" className="text-xs text-muted-foreground">
            {labels.empty}
          </p>
        ) : (
          <>
            <ParetoPlot chart={chart} labels={labels} selectedCandidateId={selectedCandidateId} />
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <span aria-hidden="true" className="size-2 rounded-full bg-foreground" />
                {labels.frontier}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className="size-2 rounded-full border-2 border-muted-foreground bg-card"
                />
                {labels.dominated}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              {labels.summary(chart.points.length, chart.frontier.length)}
            </p>
            <details className="text-xs">
              <summary className="cursor-pointer rounded-sm focus-visible:outline-2 focus-visible:outline-ring">
                {labels.details}
              </summary>
              <div className="scrollbar-sleek mt-2 max-h-64 overflow-auto">
                <table className="w-full text-left" aria-label={labels.details}>
                  <thead>
                    <tr className="border-b text-muted-foreground">
                      <th scope="col" className="px-2 py-1.5 font-medium">
                        {labels.candidate}
                      </th>
                      <th scope="col" className="px-2 py-1.5 text-right font-medium">
                        {labels.cost}
                      </th>
                      <th scope="col" className="px-2 py-1.5 text-right font-medium">
                        {labels.score}
                      </th>
                      <th scope="col" className="px-2 py-1.5 font-medium">
                        {labels.status}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {chart.points.map((point) => (
                      <tr key={point.candidate.id} className="border-b last:border-0">
                        <th scope="row" className="px-2 py-1.5 font-medium">
                          {onCandidateSelect ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="xs"
                              className="h-auto max-w-full justify-start whitespace-normal break-words text-left"
                              aria-pressed={point.candidate.id === selectedCandidateId}
                              onClick={() => onCandidateSelect(point.candidate)}
                            >
                              {point.candidate.label || point.candidate.id}
                            </Button>
                          ) : (
                            point.candidate.label || point.candidate.id
                          )}
                        </th>
                        <td className="px-2 py-1.5 text-right tabular-nums">
                          {labels.formatCost(point.costUsd)}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums">
                          {labels.formatScore(point.score)}
                        </td>
                        <td className="px-2 py-1.5">
                          {point.onFrontier ? labels.frontier : labels.dominated}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </>
        )}
        {chart.omittedCount > 0 && (
          <p role="status" className="text-xs text-muted-foreground">
            {labels.omitted(chart.omittedCount)}
          </p>
        )}
      </CardContent>
    </Card>
  )
}
