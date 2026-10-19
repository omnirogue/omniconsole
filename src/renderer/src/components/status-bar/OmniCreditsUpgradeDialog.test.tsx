// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { creditsExhaustedSchema } from '../../../../shared/omni-credits'
import { formatOmniCreditsDate, OmniCreditsUpgradeDialog } from './OmniCreditsUpgradeDialog'
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => String(values?.[key] ?? ''))
}))
afterEach(cleanup)
const base = {
  error: 'credits_exhausted',
  balance: 40,
  needed: 576,
  period_end: '2026-11-01T00:00:00Z'
}
it('shows admin pricing and uses the safe external opener with the server URL', () => {
  const openUrl = vi.fn().mockResolvedValue(undefined)
  Object.assign(window, { api: { shell: { openUrl } } })
  const event = creditsExhaustedSchema.parse({
    ...base,
    upgrade: {
      can_upgrade: true,
      url: 'https://app.omnisi.ai/billing?upgrade=credits',
      next_plan: { id: 'pro', name: 'Pro', price: '$299', monthly_credits: 15000 }
    }
  })
  const close = vi.fn()
  render(<OmniCreditsUpgradeDialog event={event} onClose={close} />)
  expect(screen.getByText(/This needs 576 credits and you have 40/)).toBeVisible()
  fireEvent.click(
    screen.getByRole('button', { name: /Upgrade to Pro — \$299\/month, 15,000 credits a month/ })
  )
  expect(openUrl).toHaveBeenCalledWith(event.upgrade.url)
  fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
  expect(close).toHaveBeenCalled()
})
it('asks non-admins to contact their admin without showing a sales CTA', () => {
  render(<OmniCreditsUpgradeDialog event={creditsExhaustedSchema.parse(base)} onClose={vi.fn()} />)
  expect(screen.getByText('Ask an admin on your team to upgrade.')).toBeVisible()
  expect(screen.queryByRole('button', { name: /Upgrade to/ })).toBeNull()
})
it('shows the top-plan variant without a price', () => {
  render(
    <OmniCreditsUpgradeDialog
      event={creditsExhaustedSchema.parse({
        ...base,
        upgrade: { can_upgrade: true, next_plan: null }
      })}
      onClose={vi.fn()}
    />
  )
  expect(screen.getByText(/Need more sooner\? Contact us/)).toBeVisible()
  expect(screen.queryByText(/\$299/)).toBeNull()
})
it('does not invent a refill date when it is absent or invalid', () => {
  expect(formatOmniCreditsDate()).toBe('Not available')
  expect(formatOmniCreditsDate('bad')).toBe('Not available')
})

const starter = { id: 'starter', name: 'Starter', price: '$49.99', monthly_credits: 4000 }
it.each([
  { plan: { id: 'free' }, upgrade: { can_upgrade: true } },
  {
    plan: { id: 'custom', monthly_credits: 0 },
    upgrade: { can_upgrade: true, url: 'https://app.omnisi.ai/billing', next_plan: starter }
  }
])('shows Free copy without refill promises for %j', ({ plan, upgrade }) => {
  render(
    <OmniCreditsUpgradeDialog
      event={creditsExhaustedSchema.parse({
        ...base,
        balance: 0,
        plan,
        upgrade
      })}
      onClose={vi.fn()}
    />
  )
  expect(screen.getByText('Choose a plan to keep going')).toBeVisible()
  expect(
    screen.getByText(
      'Your team has no credits on the Free plan. Pick a plan to make images, videos and reviews.'
    )
  ).toBeVisible()
  expect(screen.queryByText(/refill/i)).toBeNull()
})
it('never opens an unsafe upgrade URL', () => {
  const openUrl = vi.fn()
  Object.assign(window, { api: { shell: { openUrl } } })
  render(
    <OmniCreditsUpgradeDialog
      event={creditsExhaustedSchema.parse({
        ...base,
        upgrade: { can_upgrade: true, url: 'http://billing.test', next_plan: { name: 'Pro' } }
      })}
      onClose={vi.fn()}
    />
  )
  const button = screen.getByRole('button', { name: /Upgrade to/ })
  expect(button).toBeDisabled()
  fireEvent.click(button)
  expect(openUrl).not.toHaveBeenCalled()
})

it.each([
  [{ id: 'enterprise', name: 'Enterprise', contact: true }, 'Talk to us about Enterprise'],
  [
    { name: 'Enterprise', price: '$2,500', interval: 'once' },
    'Upgrade to Enterprise — $2,500 one-time'
  ],
  [
    { name: 'Enterprise', price: '$297', setup_price: '$2,500' },
    'Upgrade to Enterprise — $2,500 setup + $297/month'
  ]
])('renders next plan %j', (next_plan, label) => {
  const openUrl = vi.fn().mockResolvedValue(undefined)
  Object.assign(window, { api: { shell: { openUrl } } })
  render(
    <OmniCreditsUpgradeDialog
      event={creditsExhaustedSchema.parse({
        ...base,
        upgrade: { can_upgrade: true, url: 'https://billing.test/up', next_plan }
      })}
      onClose={vi.fn()}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: label }))
  expect(openUrl).toHaveBeenCalledWith('https://billing.test/up')
})

it('tells an Enterprise team (no monthly credits, no bigger plan) to contact us, not to choose a plan', () => {
  render(
    <OmniCreditsUpgradeDialog
      event={creditsExhaustedSchema.parse({
        ...base,
        balance: 0,
        needed: 317,
        plan: { id: 'enterprise', monthly_credits: 0 },
        upgrade: { can_upgrade: true, url: 'https://app.omnisi.ai/billing' }
      })}
      onClose={vi.fn()}
    />
  )
  expect(screen.getByText("You're out of credits")).toBeVisible()
  expect(screen.getByText('Contact us to add credits to your agreement.')).toBeVisible()
  expect(screen.queryByText(/Choose a plan/)).toBeNull()
  expect(screen.queryByText(/refill/i)).toBeNull()
})
