// @vitest-environment happy-dom
/**
 * Design-polish regressions from Sal's 2026-09-18 screenshot
 * (`evidence/sal-upnext-overflow-2026-09-18.png`): a stopped stage's 130-character reason sat
 * in the one-line summary, so the title collapsed to "Impro…" and the row ran past the panel
 * edge; "Stopped at stage 1 of 2 · needs you" rendered twice; the ▾ under the Outcome head
 * floated alone on its own line with no visible name.
 *
 * That header line is gone (`docs/reference/session-run-lifecycle.md`): a stop says its CLASS,
 * the watchdog's sentence is a diagnostic folded under Details, and "needs you" is printed only
 * for an open request — so the layout rules below are pinned against the classed stops.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { UpNextChainView } from './UpNextChain'
import { agentFixture, upNextFixture } from './up-next-fixture'
import type { UpNextController } from './use-up-next'

afterEach(cleanup)

const LONG_REASON =
  "No activity was observed for 180s after this step's instruction was accepted, so the step is not running. Open that conversation to see what happened, then run the step again. " +
  'The seat never wrote a receipt, and the host has no transcript line to quote for it either.'

/** The stage's own Details disclosure, inside its open row. */
function stageDetails(stage: HTMLElement): HTMLElement {
  return within(stage.querySelector('[data-up-next-diagnostic="stage"]') as HTMLElement).getByRole(
    'button',
    { name: /Details/ }
  )
}

function controller(scenario: string): UpNextController {
  const write = () => vi.fn(async () => true)
  return {
    view: upNextFixture(scenario),
    error: null,
    disabled: false,
    append: write(),
    update: write(),
    reorder: write(),
    remove: write(),
    commit: write(),
    discardDrafts: write(),
    configureAfter: write()
  }
}

function row(id: string): HTMLElement {
  return document.querySelector(`[data-up-next-block="${id}"]`) as HTMLElement
}

it('keeps the title readable beside a 300-character summary: the summary yields, the title has priority', () => {
  const c = controller('chain')
  const long = agentFixture('long', {
    template: 'improve',
    progress: { verdictSummary: 'x'.repeat(300) }
  })
  c.view!.blocks = [long, ...c.view!.blocks.slice(1)]
  render(<UpNextChainView controller={c} />)
  const title = within(row('long')).getByText('Improve')
  const summary = row('long').querySelector('[data-up-next-secondary]')!
  expect(title.textContent).toBe('Improve')
  // The title truncates only after the summary has fully collapsed: a capped natural width,
  // never a proportional share of the overflow.
  expect(title.className).toContain('max-w-[60%]')
  expect(title.className).toContain('truncate')
  // Only the narrow-row variant lets the title flex; at full width it keeps its natural size.
  expect(title.className).not.toMatch(/(^|\s)flex-1(\s|$)/)
  // The summary is the flexible item: zero basis, may shrink to nothing, ellipsis when it does.
  expect(summary.className).toContain('min-w-0')
  expect(summary.className).toContain('flex-1')
  expect(summary.className).toContain('truncate')
  expect(summary.textContent!.length).toBeGreaterThanOrEqual(300)
  // Truncated on the line, but never lost: the full text is reachable from the span's title.
  expect(summary.getAttribute('title')).toContain('x'.repeat(300))
  // The row body itself is contained: it can never be wider than the card.
  const body = row('long').querySelector('[data-up-next-row]')!
  expect(body.className).toContain('min-w-0')
})

it('prints a started stage’s verdict summary in full, wrapped, in its open body', () => {
  const c = controller('failed')
  const verify = c.view!.blocks.find((block) => block.id === 'verify')!
  if (verify.kind !== 'agent') {
    throw new Error('missing verify stage')
  }
  verify.progress = { blockedReason: 'receipt never signed', verdictSummary: 'y'.repeat(300) }
  render(<UpNextChainView controller={c} />)
  const stage = row('verify')
  // The stopped row is open by itself; the verdict follows the reason and precedes the shape.
  const facts = stage.querySelector('[data-up-next-verdict-summary]')!
  expect(facts.textContent).toBe('y'.repeat(300))
  expect(facts.className).toContain('whitespace-pre-wrap')
  expect(facts.className).toContain('break-words')
  expect(facts.className).not.toContain('truncate')
  // It follows the stop's own line (class first, diagnostic folded) and precedes the shape.
  expect(facts.previousElementSibling).toBe(stage.querySelector('[data-up-next-stop="failed"]'))
  expect(facts.nextElementSibling!.textContent).toContain('1 agent · solo')
  // A screen reader hears the stage number from the row itself; the rail badge is decoration.
  expect(stage.querySelector('[data-up-next-row] .sr-only')!.textContent).toBe('3')
  expect(stage.querySelector('[data-up-next-rail-badge]')!.getAttribute('aria-hidden')).toBe('true')
})

it('shows a stopped stage as a short status inline and keeps the raw reason under Details', () => {
  const c = controller('failed')
  const verify = c.view!.blocks.find((block) => block.id === 'verify')!
  if (verify.kind !== 'agent') {
    throw new Error('missing verify stage')
  }
  verify.progress = {
    blockedReason: LONG_REASON,
    stopCode: 'worker-stalled',
    stoppedAt: Date.UTC(2026, 8, 18, 14, 31)
  }
  render(<UpNextChainView controller={c} />)
  const stage = row('verify')
  const secondary = stage.querySelector('[data-up-next-secondary]')!
  expect(secondary.textContent).not.toContain('No activity was observed')
  expect(secondary.textContent).toContain('stopped')
  expect(within(stage).getByText('failed')).toBeTruthy()
  // The stopped row opens by itself and says what KIND of stop it is, in plain words …
  const stop = stage.querySelector('[data-up-next-stop="failed"]')!
  expect(stop.textContent).toContain('The agent stopped responding')
  expect(stop.className).not.toContain('truncate')
  // … while the watchdog's sentence is nowhere until the person asks for Details.
  expect(stage.textContent).not.toContain('No activity was observed')
  fireEvent.click(stageDetails(stage))
  const reason = stage.querySelector('[data-up-next-diagnostic-text]')!
  expect(reason.textContent).toBe(LONG_REASON)
  expect(reason.className).toContain('whitespace-pre-wrap')
  expect(reason.className).not.toContain('truncate')
  expect(stage.querySelector('[data-up-next-diagnostic-code]')!.textContent).toBe('worker-stalled')
  expect(screen.getByRole('button', { name: 'Configure a stage after this' })).toBeTruthy()
  // The person can still fold the whole row away.
  fireEvent.click(stage.querySelector('[data-up-next-row]')!)
  expect(stage.querySelector('[data-up-next-stop]')).toBeNull()
  fireEvent.click(stage.querySelector('[data-up-next-row]')!)
  expect(stage.querySelector('[data-up-next-stop]')).toBeTruthy()
})

it('opens again when the same stage stops a second time after its first stop was folded', () => {
  const c = controller('failed')
  const verify = c.view!.blocks.find((block) => block.id === 'verify')!
  if (verify.kind !== 'agent') {
    throw new Error('missing verify stage')
  }
  verify.progress = { blockedReason: 'first stop', stoppedAt: 1 }
  const { rerender } = render(<UpNextChainView controller={c} />)
  fireEvent.click(row('verify').querySelector('[data-up-next-row]')!)
  expect(row('verify').querySelector('[data-up-next-stop]')).toBeNull()
  // The retry stops again: same block id, a new stop — it is not the fold the person made.
  const again = controller('failed')
  const retried = again.view!.blocks.find((block) => block.id === 'verify')!
  if (retried.kind !== 'agent') {
    throw new Error('missing verify stage')
  }
  retried.progress = { blockedReason: 'second stop', stoppedAt: 2 }
  rerender(<UpNextChainView controller={again} />)
  fireEvent.click(stageDetails(row('verify')))
  expect(row('verify').querySelector('[data-up-next-diagnostic-text]')!.textContent).toBe(
    'second stop'
  )
})

it('states the run’s stop exactly once, under the Up next header, and never as "needs you"', () => {
  render(<UpNextChainView controller={controller('failed')} />)
  expect(screen.getAllByText('Failed · The agent stopped responding')).toHaveLength(1)
  const status = screen.getByRole('status')
  expect(status.textContent).toBe('Failed · The agent stopped responding')
  expect(document.querySelector('[data-up-next-chain]')!.textContent).not.toMatch(/needs you/i)
  expect(document.querySelector('[data-up-next-chain]')!.textContent).not.toContain('Stopped at')
  expect(document.querySelector('[data-up-next-summary]')!.textContent).not.toContain('Failed')
  expect(document.querySelector('[data-up-next-summary]')!.textContent).toBe(
    '1 stage · 1 execution · waiting'
  )
})

it('gives every rail badge the same box on the rail, and marks the failed stage with "!"', () => {
  render(<UpNextChainView controller={controller('failed')} />)
  const badges = [...document.querySelectorAll('[data-up-next-rail-badge]')]
  expect(badges.length).toBeGreaterThan(1)
  for (const badge of badges) {
    expect(badge.className).toContain('top-2.5')
    expect(badge.className).toContain('h-5')
    // Every tone keeps the opaque background: the rail never shows through a circle.
    expect(badge.className).toContain('bg-background')
    // A row card's 3px left border shifts its padding box to 37px; 37 − 29 = 8 centres a 20px
    // badge on the rail at 18px. A 1px-bordered placeholder gets 35 − 27 instead.
    expect(badge.className).toContain(
      badge.closest('[data-up-next-block]') ? '-left-[29px]' : '-left-[27px]'
    )
  }
  const failed = row('verify').querySelector('[data-up-next-rail-badge]')!
  expect(failed.textContent).toBe('!')
  expect(failed.className).toContain('bg-background')
  expect(failed.className).toContain('from-destructive/10')
  expect(failed.className).not.toContain('bg-destructive')
  // The ghost row at the track's end is the 1px-bordered case; it is on the rail too.
  expect(badges.some((badge) => !badge.closest('[data-up-next-block]'))).toBe(true)
})

it('marks every row with its block state beside data-up-next-row, so a fold can spot a draft', () => {
  const c = controller('chain')
  render(<UpNextChainView controller={c} />)
  const rows = [...document.querySelectorAll('[data-up-next-row]')]
  expect(rows.length).toBeGreaterThan(0)
  for (const body of rows) {
    const block = body.closest('[data-up-next-block]')!
    expect(body.getAttribute('data-up-next-state')).toBe(block.getAttribute('data-state'))
  }
  expect(document.querySelectorAll('[data-up-next-state="draft"]').length).toBe(
    c.view!.blocks.filter((block) => block.state === 'draft').length
  )
})
