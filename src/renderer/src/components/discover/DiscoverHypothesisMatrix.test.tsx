// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DiscoverHypothesisMatrix } from './DiscoverHypothesisMatrix'
import {
  DEFAULT_DISCOVER_HYPOTHESIS_MATRIX_LABELS,
  buildDiscoverHypothesisMatrixRows,
  discoverHypothesisCell,
  discoverHypothesisConfidence,
  discoverHypothesisRowVerdict,
  normalizeDiscoverEvidenceCount,
  resolveDiscoverHypothesisMatrixLabels,
  summarizeDiscoverLensCoverage,
  uniqueDiscoverEntries,
  type DiscoverHypothesis,
  type DiscoverHypothesisLens
} from './discover-hypothesis-matrix-helpers'

afterEach(cleanup)

const lenses: DiscoverHypothesisLens[] = [
  { id: 'code', name: 'Code paths' },
  { id: 'logs', name: 'Logs' }
]

const hypotheses: DiscoverHypothesis[] = [
  {
    id: 'h-retry',
    statement: 'Retries double-charge on timeout',
    cells: {
      code: { verdict: 'supported', evidenceCount: 3 },
      logs: { verdict: 'refuted', evidenceCount: 1 }
    }
  },
  {
    id: 'h-cache',
    statement: 'Stale cache serves old prices',
    cells: { code: { verdict: 'supported', evidenceCount: 2 }, logs: { verdict: 'supported' } }
  },
  { id: 'h-race', statement: 'Webhook race drops refunds', cells: {} },
  {
    id: 'h-clock',
    statement: 'Clock skew expires sessions early',
    cells: { logs: { verdict: 'refuted', evidenceCount: 4 } }
  }
]

describe('discover hypothesis matrix scoring', () => {
  it('weights each tested lens by its evidence and ignores untested ones', () => {
    expect(discoverHypothesisConfidence(hypotheses[0], lenses)).toBe(75)
    expect(discoverHypothesisConfidence(hypotheses[1], lenses)).toBe(100)
    expect(discoverHypothesisConfidence(hypotheses[2], lenses)).toBeNull()
    expect(discoverHypothesisConfidence(hypotheses[3], lenses)).toBe(0)
  })

  it('scores mixed verdicts at half and only counts lenses that are shown', () => {
    const hypothesis: DiscoverHypothesis = {
      id: 'h',
      statement: 'Mixed',
      cells: { code: { verdict: 'mixed' }, hidden: { verdict: 'refuted', evidenceCount: 9 } }
    }
    expect(discoverHypothesisConfidence(hypothesis, lenses)).toBe(50)
    expect(discoverHypothesisRowVerdict(hypothesis, lenses)).toBe('mixed')
  })

  it('derives one verdict per row from its tested lenses', () => {
    expect(
      hypotheses.map((hypothesis) => discoverHypothesisRowVerdict(hypothesis, lenses))
    ).toEqual(['mixed', 'supported', 'untested', 'refuted'])
  })

  it('treats bad evidence counts as zero and missing cells as untested', () => {
    expect(normalizeDiscoverEvidenceCount(undefined)).toBe(0)
    expect(normalizeDiscoverEvidenceCount(-2)).toBe(0)
    expect(normalizeDiscoverEvidenceCount(Number.NaN)).toBe(0)
    expect(normalizeDiscoverEvidenceCount(2.7)).toBe(2)
    expect(discoverHypothesisCell(hypotheses[2], 'code')).toEqual({
      verdict: 'untested',
      evidenceCount: 0
    })
  })

  it('filters by row verdict and sorts by confidence with untested rows last', () => {
    const sorted = buildDiscoverHypothesisMatrixRows(hypotheses, lenses, {
      filter: 'all',
      sort: 'confidence'
    })
    expect(sorted.map((row) => row.hypothesis.id)).toEqual([
      'h-cache',
      'h-retry',
      'h-clock',
      'h-race'
    ])
    const refuted = buildDiscoverHypothesisMatrixRows(hypotheses, lenses, {
      filter: 'refuted',
      sort: 'original'
    })
    expect(refuted.map((row) => row.hypothesis.id)).toEqual(['h-clock'])
  })

  it('counts tested hypotheses per lens and drops duplicate ids', () => {
    expect(summarizeDiscoverLensCoverage(hypotheses, lenses)).toEqual([
      { lensId: 'code', tested: 2, total: 4 },
      { lensId: 'logs', tested: 3, total: 4 }
    ])
    expect(uniqueDiscoverEntries([...lenses, { id: 'code', name: 'Again' }])).toEqual(lenses)
  })

  it('merges label overrides over the defaults, including single verdicts', () => {
    expect(resolveDiscoverHypothesisMatrixLabels()).toBe(DEFAULT_DISCOVER_HYPOTHESIS_MATRIX_LABELS)
    const labels = resolveDiscoverHypothesisMatrixLabels({
      heading: 'Matriz',
      verdicts: { refuted: 'Refutada' }
    })
    expect(labels.heading).toBe('Matriz')
    expect(labels.verdicts.refuted).toBe('Refutada')
    expect(labels.verdicts.supported).toBe('Supported')
    expect(labels.evidence(1)).toBe('1 source')
    expect(labels.evidence(3)).toBe('3 sources')
  })
})

describe('DiscoverHypothesisMatrix', () => {
  it('renders one row per hypothesis and one column per lens', () => {
    render(<DiscoverHypothesisMatrix hypotheses={hypotheses} lenses={lenses} />)
    expect(screen.getByRole('heading', { name: 'Hypothesis matrix' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Code paths' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Logs' })).toBeInTheDocument()
    expect(screen.getAllByRole('rowheader').map((cell) => cell.textContent)).toEqual([
      'Retries double-charge on timeout',
      'Stale cache serves old prices',
      'Webhook race drops refunds',
      'Clock skew expires sessions early',
      'Tested'
    ])
    expect(screen.getByRole('status')).toHaveTextContent('Showing 4 of 4 hypotheses')
    const retry = screen.getByRole('row', { name: /Retries double-charge/ })
    expect(within(retry).getByText('75%')).toBeInTheDocument()
    const race = screen.getByRole('row', { name: /Webhook race/ })
    expect(within(race).getByText('Not tested')).toBeInTheDocument()
  })

  it('uses label overrides for every visible string it controls', () => {
    render(
      <DiscoverHypothesisMatrix
        hypotheses={hypotheses}
        lenses={lenses}
        labels={{
          heading: 'Matriz de hipótesis',
          hypothesisColumn: 'Hipótesis',
          confidenceColumn: 'Confianza',
          filterAll: 'Todas',
          sortByConfidence: 'Ordenar',
          verdicts: { supported: 'Respaldada' },
          shown: (shown, total) => `${shown} de ${total}`
        }}
      />
    )
    expect(screen.getByRole('heading', { name: 'Matriz de hipótesis' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Hipótesis' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Confianza' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Todas' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Respaldada' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Ordenar' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('4 de 4')
  })

  it('filters rows by verdict and shows the filter empty state', () => {
    render(
      <DiscoverHypothesisMatrix
        hypotheses={hypotheses.slice(0, 2)}
        lenses={lenses}
        labels={{ emptyFilter: 'Nothing here' }}
      />
    )
    const supported = screen.getByRole('button', { name: 'Supported' })
    fireEvent.click(supported)
    expect(supported).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getAllByRole('row', { name: /Stale cache/ })).toHaveLength(1)
    expect(screen.queryByRole('row', { name: /Retries double-charge/ })).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Showing 1 of 2 hypotheses')
    fireEvent.click(screen.getByRole('button', { name: 'Untested' }))
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(screen.getByText('Nothing here')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'All' }))
    expect(screen.getByRole('table')).toBeInTheDocument()
  })

  it('toggles confidence sorting', () => {
    render(<DiscoverHypothesisMatrix hypotheses={hypotheses} lenses={lenses} />)
    const sort = screen.getByRole('button', { name: 'Sort by confidence' })
    fireEvent.click(sort)
    expect(sort).toHaveAttribute('aria-pressed', 'true')
    const order = () =>
      screen
        .getAllByRole('rowheader')
        .map((cell) => cell.textContent)
        .slice(0, 4)
    expect(order()).toEqual([
      'Stale cache serves old prices',
      'Retries double-charge on timeout',
      'Clock skew expires sessions early',
      'Webhook race drops refunds'
    ])
    fireEvent.click(sort)
    expect(order()[0]).toBe('Retries double-charge on timeout')
  })

  it('reports the selected cell and marks it pressed', () => {
    const onSelectCell = vi.fn()
    render(
      <DiscoverHypothesisMatrix
        hypotheses={hypotheses}
        lenses={lenses}
        selectedCell={{ hypothesisId: 'h-retry', lensId: 'logs' }}
        onSelectCell={onSelectCell}
      />
    )
    const selected = screen.getByRole('button', {
      name: 'Retries double-charge on timeout, Logs: Refuted, 1 source'
    })
    expect(selected).toHaveAttribute('aria-pressed', 'true')
    const other = screen.getByRole('button', {
      name: 'Stale cache serves old prices, Code paths: Supported, 2 sources'
    })
    expect(other).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(other)
    expect(onSelectCell).toHaveBeenCalledWith({ hypothesisId: 'h-cache', lensId: 'code' })
  })

  it('renders read-only cells without a selection handler', () => {
    render(<DiscoverHypothesisMatrix hypotheses={hypotheses} lenses={lenses} />)
    expect(
      screen.queryByRole('button', { name: /Retries double-charge on timeout, Logs/ })
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('group', {
        name: 'Retries double-charge on timeout, Logs: Refuted, 1 source'
      })
    ).toBeInTheDocument()
  })

  it('shows per-lens coverage in the footer', () => {
    render(<DiscoverHypothesisMatrix hypotheses={hypotheses} lenses={lenses} />)
    const footer = screen.getByRole('row', { name: /^Tested/ })
    expect(within(footer).getByText('2/4')).toBeInTheDocument()
    expect(within(footer).getByText('3/4')).toBeInTheDocument()
  })

  it('shows the empty matrix message and no controls when there are no hypotheses', () => {
    render(
      <DiscoverHypothesisMatrix hypotheses={[]} lenses={lenses} labels={{ emptyMatrix: 'Empty' }} />
    )
    expect(screen.getByText('Empty')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('collapses duplicate hypothesis and lens ids', () => {
    render(
      <DiscoverHypothesisMatrix
        hypotheses={[...hypotheses, { ...hypotheses[0], statement: 'Duplicate' }]}
        lenses={[...lenses, { id: 'logs', name: 'Logs again' }]}
      />
    )
    expect(screen.queryByText('Duplicate')).not.toBeInTheDocument()
    expect(screen.queryByRole('columnheader', { name: 'Logs again' })).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Showing 4 of 4 hypotheses')
  })
})
