// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FinancialTrend } from './FinancialTrend'
import type { FinancialHistory } from './financial-history'

let host: HTMLDivElement
let root: Root

function render(node: React.ReactNode): void {
  act(() => {
    root.render(node)
  })
}

/** A history of `count` days where every day has a figure for every metric. */
function history(count: number): FinancialHistory {
  const days = Array.from(
    { length: count },
    (_, index) => `2026-09-${String(index + 1).padStart(2, '0')}`
  )
  const series = (['revenue', 'ad_spend', 'api_cost', 'pnl'] as const).map((metric) => ({
    metric,
    label: metric,
    points: days.map((date, index) => ({ date, value: 100 + index })),
    cohort: ['OmniRogue'],
    covered: count
  }))
  return { start: days[0], end: days.at(-1) ?? days[0], days, series, notes: [] }
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  act(() => {
    root = createRoot(host)
  })
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('the seven-day money chart', () => {
  it('shows the last day by default', () => {
    render(<FinancialTrend history={history(7)} />)
    const pressed = [...host.querySelectorAll('[aria-pressed="true"]')]
    expect(pressed).toHaveLength(1)
    expect(pressed[0].textContent).toBe('09-07')
  })

  it('keeps the picked day inside a window that shrank under it', () => {
    // `active` survives a change of history. Picking day 7 and then receiving a
    // two-day window left the selection pointing past the end: the point lookup
    // missed, so the legend read "— gap" for a day that has a figure, and the
    // guide line was drawn outside the plot.
    render(<FinancialTrend history={history(7)} />)
    const last = [...host.querySelectorAll('button[aria-pressed]')].at(-1) as HTMLButtonElement
    act(() => last.click())
    expect(last.getAttribute('aria-pressed')).toBe('true')

    render(<FinancialTrend history={history(2)} />)
    const buttons = [...host.querySelectorAll('button[aria-pressed]')]
    expect(buttons).toHaveLength(2)
    // Exactly one day is selected, and it is one that exists.
    const selected = buttons.filter((button) => button.getAttribute('aria-pressed') === 'true')
    expect(selected).toHaveLength(1)
    // Its figures read, rather than reporting a gap for data that is present.
    const legend = host.querySelector('[data-trend-legend]')
    expect(legend?.textContent).not.toContain('— gap')
  })

  it('draws the guide line inside the plot after the window shrinks', () => {
    render(<FinancialTrend history={history(7)} />)
    const last = [...host.querySelectorAll('button[aria-pressed]')].at(-1) as HTMLButtonElement
    act(() => last.click())
    render(<FinancialTrend history={history(2)} />)
    const xs = [...host.querySelectorAll('line')]
      .map((line) => Number(line.getAttribute('x1')))
      .filter((value) => Number.isFinite(value))
    // The viewBox is 960 wide; nothing may be plotted beyond its right gutter.
    expect(Math.max(...xs)).toBeLessThanOrEqual(960)
    expect(xs.every((value) => value >= 0)).toBe(true)
  })

  it('survives a single-day window without dividing by zero', () => {
    render(<FinancialTrend history={history(1)} />)
    const circles = [...host.querySelectorAll('circle')].map((circle) =>
      Number(circle.getAttribute('cx'))
    )
    expect(circles.length).toBeGreaterThan(0)
    expect(circles.every((value) => Number.isFinite(value))).toBe(true)
  })

  it('says so plainly when there is no comparable history', () => {
    render(<FinancialTrend history={null} />)
    expect(host.textContent).toContain('No comparable financial history')
  })

  it('breaks the line on a gap rather than drawing through it', () => {
    const withGap = history(3)
    withGap.series[0].points[1] = { date: withGap.days[1], value: null }
    withGap.series[0].covered = 2
    render(<FinancialTrend history={withGap} />)
    const paths = [...host.querySelectorAll('path')].map((path) => path.getAttribute('d') ?? '')
    // The revenue line restarts after the gap, so it carries two move commands.
    expect(paths.some((d) => (d.match(/M/g) ?? []).length === 2)).toBe(true)
  })
})
