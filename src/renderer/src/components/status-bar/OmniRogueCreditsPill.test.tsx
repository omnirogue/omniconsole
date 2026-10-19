// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OmniRogueSessionSpend } from '../../../../preload/api/omnirogue-api'
import { OmniRogueCreditsPill } from './OmniRogueCreditsPill'

const state = { settings: { experimentalOmniSiPreviews: false } }
vi.mock('@/store', () => ({
  useAppStore: (selector: (value: typeof state) => unknown) => selector(state)
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, english: string, values?: Record<string, unknown>) =>
    english.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(values?.[name] ?? ''))
}))

const listSessions = vi.fn()
const spend: OmniRogueSessionSpend = {
  sessionId: 'session-1',
  spentCredits: 90,
  reservedCredits: 0,
  budgetCredits: 100,
  requestCount: 3,
  updatedAt: 1
}

beforeEach(() => {
  state.settings.experimentalOmniSiPreviews = false
  listSessions.mockReset().mockResolvedValue([spend])
  const balance = { availableCredits: 500, lowBalanceThreshold: 100 }
  Object.assign(window, {
    api: {
      omnirogue: {
        credits: {
          getBalance: vi.fn().mockResolvedValue(balance),
          refreshBalance: vi.fn().mockResolvedValue(balance),
          openTopUp: vi.fn(),
          onBalanceChanged: vi.fn(() => () => undefined)
        },
        account: {
          getStatus: vi.fn().mockResolvedValue({ state: 'linked' }),
          onStatusChanged: vi.fn(() => () => undefined),
          link: vi.fn()
        },
        spend: {
          listSessions,
          onSessionChanged: vi.fn(() => () => undefined)
        }
      }
    }
  })
})
afterEach(cleanup)

async function openPill() {
  render(<OmniRogueCreditsPill />)
  fireEvent.click(await screen.findByTestId('omnirogue-credits-pill'))
  await screen.findByTestId('omnirogue-credits-balance-value')
}

describe('OmniRogueCreditsPill previews', () => {
  it('keeps the OmniSI preview tools out while previews are off', async () => {
    await openPill()
    expect(screen.queryByTestId('omnirogue-preview-tools')).toBeNull()
    expect(listSessions).not.toHaveBeenCalled()
  })

  it('shows the session spend guard and opens Model Arena outside the popover', async () => {
    state.settings.experimentalOmniSiPreviews = true
    await openPill()
    expect(await screen.findByTestId('omnirogue-spend-guard-banner')).toHaveAttribute(
      'data-period',
      'session'
    )
    expect(screen.getByText('Session spend limit almost reached')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Model Arena' }))
    await waitFor(() => expect(screen.queryByTestId('omnirogue-preview-tools')).toBeNull())
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })
})
