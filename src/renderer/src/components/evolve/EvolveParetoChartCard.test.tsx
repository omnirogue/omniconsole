// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EvolveParetoChartCard } from './EvolveParetoChartCard'
import {
  buildEvolveParetoChart,
  DEFAULT_EVOLVE_PARETO_CHART_LABELS as defaults,
  EVOLVE_PARETO_PLOT,
  type EvolveParetoCandidate,
  type EvolveParetoChartLabels
} from './evolve-pareto-chart-helpers'

afterEach(cleanup)

function candidate(id: string, costUsd: number, score: number): EvolveParetoCandidate {
  return { id, label: id, costUsd, score }
}

const candidates = [
  candidate('Expensive', 8, 0.9),
  candidate('Dominated', 6, 0.6),
  candidate('Balanced', 4, 0.8),
  candidate('Cheap', 1, 0.5)
]

function openDetails(label = defaults.details) {
  fireEvent.click(screen.getByText(label, { selector: 'summary' }))
  return screen.getByRole('table', { name: label })
}

describe('buildEvolveParetoChart', () => {
  it('finds the frontier in cost order without reordering or mutating the input', () => {
    const input = Object.freeze(candidates.map((point) => Object.freeze({ ...point })))
    const chart = buildEvolveParetoChart(input)
    expect(chart.frontier.map((point) => point.candidate.id)).toEqual([
      'Cheap',
      'Balanced',
      'Expensive'
    ])
    expect(chart.points.map((point) => point.candidate.id)).toEqual(input.map((point) => point.id))
    expect(chart.points.find((point) => point.candidate.id === 'Dominated')?.onFrontier).toBe(false)
    expect(input).toEqual(candidates)
  })

  it('keeps exact ties and rejects worse scores at the same cost or the same score at higher cost', () => {
    const chart = buildEvolveParetoChart([
      candidate('worse-score', 2, 0.5),
      candidate('tie-a', 2, 0.8),
      candidate('higher-cost', 3, 0.8),
      candidate('tie-b', 2, 0.8),
      candidate('higher-score', 4, 0.9)
    ])
    expect(chart.frontier.map((point) => point.candidate.id)).toEqual([
      'tie-a',
      'tie-b',
      'higher-score'
    ])
  })

  it('agrees with strict pairwise dominance regardless of input order', () => {
    const grid = [0, 1, 2, 3].flatMap((cost) =>
      [-1, 0, 1, 2].map((score) => candidate(`${cost}:${score}`, cost, score))
    )
    for (const input of [grid, grid.toReversed(), [...grid.slice(7), ...grid.slice(0, 7)]]) {
      const chart = buildEvolveParetoChart(input)
      for (const point of chart.points) {
        const dominated = chart.points.some(
          (other) =>
            other.costUsd <= point.costUsd &&
            other.score >= point.score &&
            (other.costUsd < point.costUsd || other.score > point.score)
        )
        expect(point.onFrontier).toBe(!dominated)
      }
    }
  })

  it('omits incomplete, nonfinite, negative-cost and duplicate records without losing zero values', () => {
    const chart = buildEvolveParetoChart([
      { id: 'missing', label: 'Missing' },
      { id: 'null-score', label: 'Null score', costUsd: 1, score: null },
      { id: 'null-cost', label: 'Null cost', costUsd: null, score: 1 },
      candidate('nan', 1, Number.NaN),
      candidate('infinite-cost', Infinity, 1),
      candidate('infinite-score', 1, -Infinity),
      candidate('negative-cost', -1, 0.5),
      candidate(' ', 1, 1),
      candidate('zero', 0, 0),
      candidate('zero', 1, 1),
      candidate('negative-score', 1, -2)
    ])
    expect(chart.omittedCount).toBe(9)
    expect(chart.points.map((point) => point.candidate.id)).toEqual(['zero', 'negative-score'])
    expect(chart.frontier.map((point) => point.candidate.id)).toEqual(['zero'])
  })

  it('allows a valid measurement after an invalid record with the same id', () => {
    const chart = buildEvolveParetoChart([
      { id: 'pending', label: 'Pending' },
      candidate('pending', 1, 0.8)
    ])
    expect(chart.points).toHaveLength(1)
    expect(chart.omittedCount).toBe(1)
  })

  it.each([
    [candidate('zero', 0, 0)],
    [candidate('single', 4, 0.9)],
    [candidate('negative', 0, -4)],
    [candidate('a', 0, 1), candidate('b', 0, 1)],
    [candidate('tiny', Number.MIN_VALUE, Number.MIN_VALUE)],
    [candidate('low', 0, -Number.MAX_VALUE), candidate('high', Number.MAX_VALUE, Number.MAX_VALUE)]
  ])('keeps degenerate and extreme domains finite: %j', (...input) => {
    const chart = buildEvolveParetoChart(input)
    for (const point of chart.points) {
      expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true)
      expect(point.x).toBeGreaterThanOrEqual(EVOLVE_PARETO_PLOT.left)
      expect(point.x).toBeLessThanOrEqual(EVOLVE_PARETO_PLOT.right)
      expect(point.y).toBeGreaterThanOrEqual(EVOLVE_PARETO_PLOT.top)
      expect(point.y).toBeLessThanOrEqual(EVOLVE_PARETO_PLOT.bottom)
    }
    for (const tick of [...chart.costTicks, ...chart.scoreTicks]) {
      expect(Number.isFinite(tick.value) && Number.isFinite(tick.position)).toBe(true)
    }
  })

  it('places higher scores above lower scores and higher costs to the right', () => {
    const { points } = buildEvolveParetoChart(candidates)
    const expensive = points[0]
    const cheap = points[3]
    expect(expensive.x).toBeGreaterThan(cheap.x)
    expect(expensive.y).toBeLessThan(cheap.y)
  })

  it('returns an empty frontier for an empty run', () => {
    expect(buildEvolveParetoChart([])).toMatchObject({ points: [], frontier: [], omittedCount: 0 })
  })
})

describe('EvolveParetoChartCard', () => {
  it('renders a named chart and a table containing every measured candidate', () => {
    render(<EvolveParetoChartCard candidates={candidates} />)
    expect(screen.getByRole('region', { name: defaults.title })).toBeInTheDocument()
    const plot = screen.getByRole('img', { name: defaults.title })
    expect(plot).toHaveAccessibleDescription(defaults.summary(4, 3))
    expect(plot.querySelectorAll('circle[data-frontier="true"]')).toHaveLength(3)
    expect(plot.querySelectorAll('circle[data-frontier="false"]')).toHaveLength(1)
    const table = openDetails()
    expect(within(table).getAllByRole('row')).toHaveLength(5)
    const row = within(table).getByRole('rowheader', { name: 'Dominated' }).closest('tr')!
    expect(within(row).getByRole('cell', { name: defaults.dominated })).toBeInTheDocument()
    expect(within(table).queryByRole('button')).not.toBeInTheDocument()
  })

  it('shows an empty state and an explicit omission count instead of plotting invalid measurements', () => {
    const { rerender } = render(<EvolveParetoChartCard candidates={[]} />)
    expect(screen.getByRole('status')).toHaveTextContent(defaults.empty)
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    rerender(<EvolveParetoChartCard candidates={[candidate('invalid', -1, 1)]} />)
    expect(screen.getByText(defaults.omitted(1))).toBeInTheDocument()
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })

  it('keeps valid points when other measurements are missing', () => {
    render(
      <EvolveParetoChartCard candidates={[...candidates, { id: 'pending', label: 'Pending' }]} />
    )
    expect(screen.getByRole('img')).toBeInTheDocument()
    expect(screen.getByText(defaults.omitted(1))).toBeInTheDocument()
  })

  it('dispatches selection from native buttons and reflects the controlled selected id', () => {
    const onCandidateSelect = vi.fn()
    const { rerender } = render(
      <EvolveParetoChartCard candidates={candidates} onCandidateSelect={onCandidateSelect} />
    )
    openDetails()
    const button = screen.getByRole('button', { name: 'Balanced' })
    button.focus()
    expect(button).toHaveFocus()
    expect(button).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(button)
    expect(onCandidateSelect).toHaveBeenCalledExactlyOnceWith(candidates[2])
    rerender(
      <EvolveParetoChartCard
        candidates={candidates}
        selectedCandidateId={candidates[2].id}
        onCandidateSelect={onCandidateSelect}
      />
    )
    expect(button).toHaveAttribute('aria-pressed', 'true')
    const selected = screen.getByRole('img').querySelector('[data-candidate-id="Balanced"]')
    expect(selected?.querySelectorAll('circle')).toHaveLength(2)
  })

  it('recomputes the frontier when measurements change and tolerates a stale selection', () => {
    const { rerender } = render(
      <EvolveParetoChartCard candidates={candidates} selectedCandidateId={candidates[2].id} />
    )
    rerender(
      <EvolveParetoChartCard
        candidates={[candidate('new', 0, 1)]}
        selectedCandidateId={candidates[2].id}
      />
    )
    const plot = screen.getByRole('img')
    expect(plot).toHaveAccessibleDescription(defaults.summary(1, 1))
    expect(plot.querySelectorAll('circle')).toHaveLength(1)
    expect(plot.querySelector('polyline')).not.toBeInTheDocument()
  })

  it('accepts labels and number formatters for every visible or accessible string', () => {
    const labels: EvolveParetoChartLabels = {
      title: 'Comparaison',
      description: 'Comparer les mesures',
      cost: 'Coût',
      score: 'Qualité',
      frontier: 'Frontière',
      dominated: 'Dominé',
      candidate: 'Candidat',
      status: 'État',
      details: 'Détails',
      empty: 'Aucune mesure',
      summary: (count, frontier) => `${frontier}/${count}`,
      omitted: (count) => `Écartés : ${count}`,
      formatCost: (cost) => `C${cost}`,
      formatScore: (score) => `Q${score}`
    }
    const input = [...candidates, { id: 'pending', label: 'Pending' }]
    const { container, rerender } = render(
      <EvolveParetoChartCard candidates={input} labels={labels} />
    )
    expect(screen.getByRole('region', { name: labels.title })).toHaveAccessibleDescription(
      labels.description
    )
    expect(screen.getByRole('img', { name: labels.title })).toHaveAccessibleDescription('3/4')
    const table = openDetails(labels.details)
    expect(within(table).getByRole('columnheader', { name: labels.cost })).toBeInTheDocument()
    expect(within(table).getByText('C4')).toBeInTheDocument()
    expect(within(table).getByText('Q0.8')).toBeInTheDocument()
    expect(screen.getByText(labels.omitted(1))).toBeInTheDocument()
    expect(container).not.toHaveTextContent(defaults.title)
    expect(container).not.toHaveTextContent(defaults.frontier)
    rerender(<EvolveParetoChartCard candidates={[]} labels={labels} />)
    expect(screen.getByRole('status')).toHaveTextContent(labels.empty)
  })

  it('uses candidate ids when labels are empty and gives multiple cards distinct accessible ids', () => {
    render(
      <>
        <EvolveParetoChartCard candidates={[{ ...candidate('fallback', 1, 1), label: '' }]} />
        <EvolveParetoChartCard candidates={candidates} />
      </>
    )
    const regions = screen.getAllByRole('region')
    expect(regions[0].getAttribute('aria-labelledby')).not.toBe(
      regions[1].getAttribute('aria-labelledby')
    )
    expect(screen.getByText('fallback', { selector: 'th' })).toBeInTheDocument()
  })
})
