// @vitest-environment happy-dom

import type { ComponentProps } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OmniRogueSpendGuardBanner } from './OmniRogueSpendGuardBanner'
import {
  OMNIROGUE_SPEND_GUARD_DEFAULT_LABELS,
  OMNIROGUE_SPEND_GUARD_DEFAULT_WARNING_RATIO,
  buildOmniRogueSpendGuardCopy,
  formatOmniRogueSpendGuardResetTime,
  formatOmniRogueSpendGuardText,
  mergeOmniRogueSpendGuardLabels,
  omniRogueSpendGuardDismissKey,
  pickOmniRogueSpendGuard,
  resolveOmniRogueSpendGuard,
  type OmniRogueSpendGuardLimit
} from './omnirogue-spend-guard-helpers'

const NOW = new Date('2026-10-16T12:00:00.000Z')

function limitOf(
  spentCredits: number,
  overrides: Partial<OmniRogueSpendGuardLimit> = {}
): OmniRogueSpendGuardLimit {
  return {
    period: 'daily',
    limitCredits: 1000,
    spentCredits,
    resetsAt: '2026-10-16T15:00:00.000Z',
    ...overrides
  }
}

function renderBanner(props: Partial<ComponentProps<typeof OmniRogueSpendGuardBanner>> = {}) {
  return render(<OmniRogueSpendGuardBanner limits={[limitOf(850)]} now={() => NOW} {...props} />)
}

afterEach(() => {
  cleanup()
})

describe('resolveOmniRogueSpendGuard', () => {
  it('stays ok below the warning ratio', () => {
    expect(resolveOmniRogueSpendGuard(limitOf(799))?.level).toBe('ok')
  })

  it('warns from the default 80% ratio and reports what is left', () => {
    const state = resolveOmniRogueSpendGuard(limitOf(800))
    expect(state).toMatchObject({
      level: 'warning',
      remainingCredits: 200,
      overageCredits: 0,
      usedRatio: 0.8,
      warningRatio: OMNIROGUE_SPEND_GUARD_DEFAULT_WARNING_RATIO
    })
    expect(state?.resetsAt?.toISOString()).toBe('2026-10-16T15:00:00.000Z')
  })

  it('is reached at the cap and reports the overage', () => {
    expect(resolveOmniRogueSpendGuard(limitOf(1000))?.level).toBe('reached')
    expect(resolveOmniRogueSpendGuard(limitOf(1250))).toMatchObject({
      level: 'reached',
      remainingCredits: 0,
      overageCredits: 250,
      usedRatio: 1.25
    })
  })

  it('honors a custom warning ratio and ignores out-of-range ones', () => {
    expect(resolveOmniRogueSpendGuard(limitOf(500, { warningRatio: 0.5 }))?.level).toBe('warning')
    expect(resolveOmniRogueSpendGuard(limitOf(500, { warningRatio: 1.5 }))?.warningRatio).toBe(
      OMNIROGUE_SPEND_GUARD_DEFAULT_WARNING_RATIO
    )
    expect(resolveOmniRogueSpendGuard(limitOf(500, { warningRatio: 0 }))?.warningRatio).toBe(
      OMNIROGUE_SPEND_GUARD_DEFAULT_WARNING_RATIO
    )
  })

  it('treats net-negative spend as zero usage', () => {
    expect(resolveOmniRogueSpendGuard(limitOf(-40))).toMatchObject({
      level: 'ok',
      spentCredits: 0,
      remainingCredits: 1000
    })
  })

  it('returns null for missing or unusable limits', () => {
    expect(resolveOmniRogueSpendGuard(null)).toBeNull()
    expect(resolveOmniRogueSpendGuard(limitOf(10, { limitCredits: 0 }))).toBeNull()
    expect(resolveOmniRogueSpendGuard(limitOf(10, { limitCredits: Number.NaN }))).toBeNull()
    expect(resolveOmniRogueSpendGuard(limitOf(Number.POSITIVE_INFINITY))).toBeNull()
  })

  it('drops an unparseable reset time', () => {
    expect(resolveOmniRogueSpendGuard(limitOf(900, { resetsAt: 'soon' }))?.resetsAt).toBeNull()
  })
})

describe('pickOmniRogueSpendGuard', () => {
  it('prefers the most severe level over a higher ratio', () => {
    const picked = pickOmniRogueSpendGuard([
      limitOf(950, { period: 'daily' }),
      limitOf(5000, { period: 'monthly', limitCredits: 5000 })
    ])
    expect(picked).toMatchObject({ period: 'monthly', level: 'reached' })
  })

  it('breaks level ties by the higher used ratio', () => {
    const picked = pickOmniRogueSpendGuard([
      limitOf(820, { period: 'daily' }),
      limitOf(4500, { period: 'weekly', limitCredits: 5000 })
    ])
    expect(picked).toMatchObject({ period: 'weekly', level: 'warning' })
  })

  it('skips unusable limits and handles empty input', () => {
    expect(pickOmniRogueSpendGuard([limitOf(10, { limitCredits: 0 })])).toBeNull()
    expect(pickOmniRogueSpendGuard(undefined)).toBeNull()
  })
})

describe('spend guard copy', () => {
  it('fills placeholders and leaves unknown ones visible', () => {
    expect(formatOmniRogueSpendGuardText('{{a}} and {{b}}', { a: 'one' })).toBe('one and {{b}}')
  })

  it('formats the reset time relative to now', () => {
    const at = (iso: string) => formatOmniRogueSpendGuardResetTime(new Date(iso), NOW)
    expect(at('2026-10-16T12:20:00.000Z')).toBe('in 20 minutes')
    expect(at('2026-10-16T15:00:00.000Z')).toBe('in 3 hours')
    expect(at('2026-10-17T12:00:00.000Z')).toBe('tomorrow')
    expect(at('2026-10-16T11:00:00.000Z')).toBeNull()
    expect(formatOmniRogueSpendGuardResetTime(null, NOW)).toBeNull()
  })

  it('keeps defaults for blank label overrides', () => {
    const labels = mergeOmniRogueSpendGuardLabels({ raiseLimitAction: '  ', periodDaily: 'Today' })
    expect(labels.raiseLimitAction).toBe(OMNIROGUE_SPEND_GUARD_DEFAULT_LABELS.raiseLimitAction)
    expect(labels.periodDaily).toBe('Today')
  })

  it('builds warning and reached copy from the default labels', () => {
    const labels = OMNIROGUE_SPEND_GUARD_DEFAULT_LABELS
    const warning = buildOmniRogueSpendGuardCopy(
      resolveOmniRogueSpendGuard(limitOf(850))!,
      labels,
      NOW
    )
    expect(warning).toEqual({
      heading: 'Daily spend limit almost reached',
      body: '850 of 1,000 credits used (85%). 150 credits left.',
      resetNote: 'Resets in 3 hours',
      progressAriaLabel: 'Daily spend limit: 85% used',
      percent: '85%'
    })
    const reached = buildOmniRogueSpendGuardCopy(
      resolveOmniRogueSpendGuard(limitOf(1200, { period: 'monthly', resetsAt: null }))!,
      labels,
      NOW
    )
    expect(reached.heading).toBe('Monthly spend limit reached')
    expect(reached.body).toContain('1,200 of 1,000 credits used.')
    expect(reached.resetNote).toBeNull()
  })

  it('changes the dismiss key on escalation and on a new period', () => {
    const warning = resolveOmniRogueSpendGuard(limitOf(850))!
    const reached = resolveOmniRogueSpendGuard(limitOf(1000))!
    const nextDay = resolveOmniRogueSpendGuard(
      limitOf(850, { resetsAt: '2026-10-17T15:00:00.000Z' })
    )!
    expect(omniRogueSpendGuardDismissKey(warning)).not.toBe(omniRogueSpendGuardDismissKey(reached))
    expect(omniRogueSpendGuardDismissKey(warning)).not.toBe(omniRogueSpendGuardDismissKey(nextDay))
  })
})

describe('OmniRogueSpendGuardBanner', () => {
  it('renders nothing while spend is under the warning ratio or no limit is set', () => {
    const { container, rerender } = renderBanner({ limits: [limitOf(100)] })
    expect(container.firstChild).toBeNull()
    rerender(<OmniRogueSpendGuardBanner limits={null} now={() => NOW} />)
    expect(container.firstChild).toBeNull()
  })

  it('shows a polite, dismissible warning with the progress toward the cap', () => {
    renderBanner()
    const banner = screen.getByTestId('omnirogue-spend-guard-banner')
    expect(banner.getAttribute('role')).toBe('status')
    expect(banner.dataset.level).toBe('warning')
    expect(screen.getByTestId('omnirogue-spend-guard-heading').textContent).toBe(
      'Daily spend limit almost reached'
    )
    expect(screen.getByTestId('omnirogue-spend-guard-reset').textContent).toBe('Resets in 3 hours')
    expect(screen.getByLabelText('Daily spend limit: 85% used')).toBeTruthy()
    expect(screen.getByTestId('omnirogue-spend-guard-dismiss')).toBeTruthy()
  })

  it('announces a reached limit as an alert and never offers dismissal', () => {
    renderBanner({ limits: [limitOf(1100)], onDismiss: vi.fn() })
    const banner = screen.getByTestId('omnirogue-spend-guard-banner')
    expect(banner.getAttribute('role')).toBe('alert')
    expect(banner.dataset.level).toBe('reached')
    expect(screen.queryByTestId('omnirogue-spend-guard-dismiss')).toBeNull()
  })

  it('hides the dismiss control when not dismissible', () => {
    renderBanner({ dismissible: false })
    expect(screen.queryByTestId('omnirogue-spend-guard-dismiss')).toBeNull()
  })

  it('stays dismissed for the same warning and reappears once the limit is reached', () => {
    const onDismiss = vi.fn()
    const { rerender } = renderBanner({ onDismiss })
    fireEvent.click(screen.getByTestId('omnirogue-spend-guard-dismiss'))
    expect(onDismiss).toHaveBeenCalledWith(expect.objectContaining({ level: 'warning' }))
    expect(screen.queryByTestId('omnirogue-spend-guard-banner')).toBeNull()

    rerender(<OmniRogueSpendGuardBanner limits={[limitOf(900)]} now={() => NOW} />)
    expect(screen.queryByTestId('omnirogue-spend-guard-banner')).toBeNull()

    rerender(<OmniRogueSpendGuardBanner limits={[limitOf(1000)]} now={() => NOW} />)
    expect(screen.getByTestId('omnirogue-spend-guard-banner').dataset.level).toBe('reached')
  })

  it('renders only the actions it was given and passes them the guard state', () => {
    const onRaiseLimit = vi.fn()
    const onReviewUsage = vi.fn()
    const { rerender } = renderBanner()
    expect(screen.queryByTestId('omnirogue-spend-guard-raise')).toBeNull()
    expect(screen.queryByTestId('omnirogue-spend-guard-review')).toBeNull()

    rerender(
      <OmniRogueSpendGuardBanner
        limits={[limitOf(1100)]}
        now={() => NOW}
        onRaiseLimit={onRaiseLimit}
        onReviewUsage={onReviewUsage}
      />
    )
    fireEvent.click(screen.getByTestId('omnirogue-spend-guard-raise'))
    fireEvent.click(screen.getByTestId('omnirogue-spend-guard-review'))
    expect(onRaiseLimit).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'reached', overageCredits: 100 })
    )
    expect(onReviewUsage).toHaveBeenCalledTimes(1)
  })

  it('uses label overrides for every visible string', () => {
    renderBanner({
      onRaiseLimit: vi.fn(),
      labels: {
        warningHeading: '{{period}}-Limit fast erreicht',
        periodDaily: 'Tages',
        raiseLimitAction: 'Limit erhöhen',
        dismissAction: 'Schließen',
        resetsIn: 'Zurückgesetzt {{time}}'
      },
      locale: 'de'
    })
    expect(screen.getByTestId('omnirogue-spend-guard-heading').textContent).toBe(
      'Tages-Limit fast erreicht'
    )
    expect(screen.getByTestId('omnirogue-spend-guard-raise').textContent).toBe('Limit erhöhen')
    expect(screen.getByLabelText('Schließen')).toBeTruthy()
    expect(screen.getByTestId('omnirogue-spend-guard-reset').textContent).toBe(
      'Zurückgesetzt in 3 Stunden'
    )
  })
})
